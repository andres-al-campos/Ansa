import AnsaCore
import SwiftUI

/// The outline, Workflowy-style: tap a bullet to zoom into that node, and the
/// breadcrumb walks back out.
///
/// The tree comes from `OutlineStore`, which applies each edit locally with the
/// same pure op the server will run and queues it for sending. Nothing in this
/// file touches the network or mutates the tree.
struct OutlineView: View {
    @State private var store = OutlineStore()
    @State private var scope: NodeId?
    /// Renaming and capture, grouped: the capture field files next to the row
    /// last edited, which only the edit path knows.
    @State private var edit = EditController()
    @FocusState private var capturing: Bool
    /// One drag's worth of state and the geometry it reads. Grouped into a type
    /// because these pieces are meaningless apart and always changed together.
    @State private var drag = DragController()
    /// The project whose delete is awaiting confirmation.
    @State private var pendingDelete: Node?


    /// How far the edge swipe has pulled the view, in points.
    ///
    /// The gesture had no on-screen answer while it was deciding: the view sat
    /// still and then the scope changed, so a swipe that fell short looked the
    /// same as one that was never recognised. Tracking the finger makes the
    /// distance itself the feedback — the view comes back if you let go early,
    /// which is how the gesture teaches its own threshold.
    @State private var backPull: CGFloat = 0
    /// Which row's field holds focus, by node id rather than a bare Bool.
    ///
    /// A single shared `Bool` across the ForEach cannot express "focus the row
    /// that is replacing this one" — the write is ambiguous between the field
    /// being torn down and the one being built, and Return-for-new-sibling
    /// lost it every time. Naming the id makes the target unambiguous.
    @FocusState private var focusedRow: NodeId?
    @Environment(\.scenePhase) private var scenePhase

    /// Prepared once rather than per tick: a generator built at the moment of
    /// the tap fires late enough to feel unrelated to the move that caused it.
    ///
    /// Two of them, because the lift and the ticks say different things. A drag
    /// arms on a timer with nothing on screen to announce it, so the lift is
    /// the only signal that the press took — it has to be felt through a
    /// pocket-sized slab held loosely, at full strength. The per-target ticks
    /// fire many times a second during a move and stay light; at the lift's
    /// weight they would turn a drag into a buzz.
    private let liftHaptic = UIImpactFeedbackGenerator(style: .heavy)
    private let haptic = UIImpactFeedbackGenerator(style: .light)

    private var tree: Tree { store.tree }

    var body: some View {
        NavigationStack {
            // Three layers, and the order is the point: the screen being
            // returned to, a shade over it, and the screen being lifted away.
            // Only the top one takes the offset — the shade and the ground
            // below it stay put, which is what makes the front slab read as
            // moving rather than the whole stack sliding together.
            ZStack {
            // The screen the swipe is going back to, rendered for real behind
            // the one being lifted off it. It is the same view as the front
            // slab — one definition, two scopes — so what is revealed during
            // the drag is what you land on, not a mock-up of it that could
            // drift.
            //
            // Inert: it takes no gestures, opens no text field, and reports no
            // row frames, so it cannot compete with the live copy for focus or
            // overwrite its geometry. Nothing about the swipe is committed
            // yet, and a screen you might still slide away from should not be
            // able to act.
            if backPull > 0 {
                slab(for: parentScope, interactive: false)
                // Over the revealed screen, under the one being lifted off it.
                backdrop
            }
            slab(for: scope, interactive: true)
            .task { store.start() }
            // A phone backgrounds this app every time the screen locks, so this
            // is the ordinary path rather than an edge case. `.task` fires once
            // when the view appears and never again, which leaves a returning
            // app holding a socket iOS killed while it was suspended — reading a
            // stale tree with no indication anything is wrong.
            //
            // `.inactive` is deliberately not handled: it covers the app
            // switcher and a passing notification banner, where tearing the
            // socket down and refetching on the way back would be churn for a
            // state the user is usually in for under a second.
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .active: store.resume()
                case .background: store.suspend()
                default: break
                }
            }
            // Follow the tree when the node being viewed is deleted elsewhere.
            // Without this the zoom keeps pointing at an id that is gone: the
            // row list walks children of nothing and comes back empty, and the
            // title falls through to "Ansa", so the screen says the project is
            // empty rather than that it is no longer there.
            //
            // Both trees are needed. A deleted node has no ancestors left in
            // the new tree, so where to land is a question only the previous
            // one can answer.
            .onChange(of: tree) { was, now in
                scope = TreeOps.survivingScope(scope, was: was, now: now)
            }
            // Two mid-edit states, and the store takes one flag, so they are
            // combined here rather than each calling setBusy on its own — the
            // one that ends first would otherwise clear the other's hold.
            //
            // Typing: the capture field holds a draft the user can see, and
            // adopting a server tree under it is what makes text vanish as it
            // is being written. Dragging: the row would move out from under the
            // finger mid-gesture.
            .onChange(of: capturing || drag.isActive || edit.isEditing) { _, busy in
                store.setBusy(busy)
            }
            // A project takes its whole subtree with it, and unlike ticking a
            // parent that is not undoable — the ops are one-way. The web arms
            // the trash and confirms in place; a dialog is the same idea in the
            // platform's own idiom, and it can say how much is going.
            // An alert rather than a confirmation dialog: on a phone the latter
            // slides up from the bottom edge as an action sheet, which reads as
            // a menu of things you might do next rather than a question that
            // has to be answered. Deleting a project takes every task under it,
            // so it wants the centred, modal version.
            //
            // The cancel is explicit. A confirmation dialog gets an implicit
            // one by tapping outside it — fine for a menu, wrong here, since
            // the way out of a destructive question should be a labelled button
            // and not a guess about where it is safe to tap.
            .alert(
                pendingDelete.map { "Delete \($0.text.isEmpty ? "Untitled" : $0.text)?" } ?? "",
                isPresented: Binding(
                    get: { pendingDelete != nil },
                    set: { if !$0 { pendingDelete = nil } }),
                presenting: pendingDelete
            ) { project in
                Button("Cancel", role: .cancel) { pendingDelete = nil }
                Button("Delete Project", role: .destructive) {
                    apply(.removeNode(id: project.id))
                    pendingDelete = nil
                }
            } message: { project in
                let count = TreeOps.subtreeOf(tree, project.id).count
                Text(count == 0
                    ? "This cannot be undone."
                    : "This deletes \(count) task\(count == 1 ? "" : "s") under it. This cannot be undone.")
            }
            // Swipe right from the left edge to zoom out, the way every other
            // iOS app pops a screen. `NavigationStack` would give this for
            // free on a pushed view, but zooming is a change of `scope` in
            // place rather than a push — there is no stack entry to pop, so
            // the gesture has to be built.
            //
            // Edge-only, not the whole width: the rows carry `swipeActions`,
            // and a full-width recogniser would race them, so a swipe meant to
            // reveal Delete would sometimes leave the project instead.
            //
            // No swipe-left counterpart. Going *in* has no unambiguous target
            // — a tree branches, so "forward" is a choice of child rather than
            // a direction — and the bullet tap already covers it.
            // The view is a slab being lifted aside, so it needs a ground to
            // be lifted *off* and an edge that casts onto it.
            //
            // The ground names where the swipe is going rather than being a
            // bare colour. Sliding onto an empty dark panel was the problem it
            // fixes: two near-identical dark surfaces with nothing on the lower
            // one read as the app failing to draw, not as depth. A label is
            // enough — this is glimpsed for a fifth of a second, so it has to
            // be legible at once and cannot repay any more detail than that.
            }
            // Attached to the whole screen but recognised *simultaneously*,
            // not exclusively.
            //
            // Attaching it plainly is what broke the row drag on a real phone:
            // an ancestor `DragGesture` recognises at 20pt of movement and
            // takes the touch sequence, and `armed` — which runs inside the
            // handler, after recognition — is far too late to give it back. The
            // row got nothing, the swipe refused to happen, and the gesture
            // died mid-screen.
            //
            // Simultaneous recognition is what lets both see the same touch, so
            // the row drag is never starved. Which one *acts* is then settled
            // by `armed`, and the two are not actually ambiguous: a back swipe
            // moves immediately from the edge, while a row drag must sit still
            // for 0.35s before it will accept any movement at all.
            //
            // An edge-strip overlay was the other candidate and is wrong here:
            // a top-level bullet is centred at x=16 and spans the full 32pt, so
            // any strip wide enough to catch a thumb sits directly on top of
            // the thing being dragged.
            //
            // None of this reproduced on the simulator. A synthesised touch
            // path arrives as one clean sequence and the recognisers never
            // contend; a finger is what produces the race.
            .simultaneousGesture(zoomOutSwipe)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if scope != nil {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Back", systemImage: "chevron.left", action: zoomOut)
                    }
                }
            }
        }
    }

    /// One screen's worth of outline, for a given scope.
    ///
    /// Parameterised rather than reading `scope` directly so the back swipe can
    /// draw two at once: the one being left and the one being returned to.
    ///
    /// - Parameter interactive: false for the copy behind the swipe. It gates
    ///   the three things that would collide with the live copy — focus, row
    ///   geometry, and gestures — at the source rather than letting a second
    ///   set of writes land and be sorted out afterwards.
    @ViewBuilder private func slab(for scope: NodeId?, interactive: Bool) -> some View {
            VStack(spacing: 0) {
                // Scrolls away with the list rather than pinning: it says where
                // you are and how far in, which is read on arrival rather than
                // watched continuously. Pinning both ends squeezed an already
                // short screen.
                // Only inside a project. On the grid each card carries its own
                // bar, and a single figure across every project at once answers
                // a question nobody asked.
                if scope != nil, let progress = TreeOps.scopeProgress(tree, scope) {
                    ScopeProgress(
                        progress: progress,
                        title: title(of: scope),
                        // Only the live copy can be a drop target; a drag and a
                        // back swipe cannot both be running.
                        lit: interactive && litRoot)
                }

                if !store.live {
                    // Only about receiving. Saying "not saved" here would be a
                    // lie that pushes people into re-typing work that is
                    // already queued and will go out on its own.
                    SyncBanner(
                        text: "Not receiving changes from other devices. Your edits are still saved.")
                }

                if scope == nil {
                    ProjectGrid(
                        tree: tree, loaded: store.loaded,
                        onOpen: openProject, onDelete: confirmDeleteProject)
                } else {
                    outline(for: scope, interactive: interactive)
                }

                // Capture sits at the bottom. It was at the top so an idea
                // could be caught without scrolling anywhere first, which is
                // what this app is for — the bottom serves that just as well,
                // and adds two things the top could not: it is inside the
                // thumb's arc, and it rises with the keyboard instead of
                // sitting at the far end of the screen from it.
                captureField(for: scope, interactive: interactive)
            }
        // Opaque, so the rows behind cannot show through the slab as it
        // moves. A `VStack` paints only what its children paint, and the
        // list's own background does not cover the whole stack.
        .background(Color(.systemBackground))
        // Only the front slab moves and casts. The one behind is the ground
        // being revealed, so it sits where it will still be once the swipe
        // finishes — sliding it too would just be the old dark-panel problem
        // with more steps.
        .shadow(color: .black.opacity(interactive && backPull > 0 ? 0.18 : 0), radius: 8, x: -3)
        .offset(x: interactive ? backPull : 0)
    }

    /// The rows themselves. Only drawn inside a project — the root shows the
    /// project grid instead.
    private func outline(for scope: NodeId?, interactive: Bool) -> some View {
        ScrollViewReader { proxy in
        List {
            ForEach(rows(of: scope), id: \.node.id) { row in
                OutlineRow(
                    node: row.node,
                    depth: row.depth,
                    hasChildren: !TreeOps.isLeaf(tree, row.node.id),
                    // False on the copy behind the swipe, which is what
                    // keeps it from building a second `TextField` bound to the
                    // same focus state as the live one. Gating focus at its
                    // single source beats gating every place it leaks to.
                    editing: interactive && edit.editing == row.node.id,
                    editText: $edit.text,
                    focusedRow: $focusedRow,
                    onToggleDone: { apply(.setDone(id: row.node.id, done: !row.node.done)) },
                    onCollapse: { apply(.toggleCollapsed(id: row.node.id)) },
                    onBeginEdit: { beginEdit(row.node) },
                    onBlur: { id in commitEdit(from: id) },
                    // Return commits and stops, rather than opening a fresh row
                    // below. The web auto-advances because typing is how you add
                    // there; the phone has a permanent "New task" field at the
                    // bottom, so a new row here was a second way to do the same
                    // thing — and it cost a keyboard dismiss-and-reopen on every
                    // Return as focus jumped.
                    onSubmit: { commitEdit() },
                    // No-ops behind the swipe. A gesture there could pick
                    // up a row on a screen the user may be about to slide away
                    // from, and its coordinates would be measured against a
                    // list that is not the one being dragged over.
                    onDragBegan: { if interactive { beginDrag(row.node.id) } },
                    // Frozen while the screen is being swiped aside. The row
                    // is still held, but its target stops following: the
                    // coordinates it would be tested against belong to a list
                    // that is sliding out of place, so the answer would be
                    // about where the row *was*.
                    onDragMoved: { p in
                        if interactive, backPull == 0 { dragMoved(p) }
                    },
                    onDragEnded: { if interactive { endDrag() } },
                    isDragging: interactive && drag.dragging == row.node.id)
                    // One segment per guide, drawn inside the row.
                    //
                    // The segments abut into what reads as a single unbroken
                    // line, which is how the web does it. Drawing one tall
                    // overlay instead looked the same at rest and broke on a
                    // swipe: `List` slides the row aside and an overlay stays
                    // put, so the line cut straight across the revealed action
                    // and had to punch a hole in itself to fake being covered.
                    // A segment is part of the row, so it slides with the row
                    // and only that row's piece of the line goes with it.
                    //
                    // The row owns its vertical spacing, and `List`'s own row
                    // insets are zeroed below, so the row frame *is* the cell.
                    // That is what lets a segment simply fill its row and still
                    // meet its neighbours.
                    //
                    // Compensating for the insets instead was the earlier
                    // approach and was wrong: it needed the inset height as a
                    // measured constant, which is right only on the device it
                    // was measured on. Where `List` insets rows differently the
                    // segments fall short by the difference and the seams show
                    // at every boundary.
                    .padding(.vertical, OutlineRow.rowPadding / 2)
                    .listRowInsets(EdgeInsets())
                    // Measured *after* the padding, so the frame is the whole
                    // cell rather than just its content. Measuring before it
                    // was the gap: every consumer here — the guide segments,
                    // the drop indicator, the drag hit-test — asks the frame
                    // where one row ends and the next begins, and a content
                    // box answers with the padding still outside it.
                    .background {
                        // Measured only on the live copy. Both lists render the
                        // same ids, so a second set of frames would not collide
                        // visibly — it would quietly overwrite the geometry the
                        // hit-test reads, and a drop would land a row off from
                        // where it looked.
                        if interactive {
                            GeometryReader { geo in
                                Color.clear.preference(
                                    key: RowFramesKey.self,
                                    value: [row.node.id: geo.frame(in: .global)])
                            }
                        }
                    }
                    .background(alignment: .topLeading) {
                        guideSegments(for: row.node.id, in: rows(of: scope))
                    }
                    // Zoom lives on a swipe rather than on the bullet.
                    // It is one Back tap to undo but replaces the whole
                    // screen, and a revealed action cannot fire from a
                    // brush the way a button in the row can — it needs
                    // a second tap, or a deliberate push past the
                    // full-swipe threshold.
                    // Behind the swipe there is nothing to zoom *into*
                    // yet — the screen has not been landed on.
                    .swipeActions(edge: .trailing) {
                        Button {
                            if interactive { self.scope = row.node.id }
                        } label: {
                            Label("Zoom in", systemImage: "chevron.right")
                        }
                        .tint(.accentColor)
                    }
            }
            .onDelete { if interactive { delete(at: $0) } }
        }
        .listStyle(.plain)
        // Frozen while the screen is being swiped aside.
        //
        // The swipe is recognised simultaneously with everything else, which
        // means it never takes the touch away from the list — so a swipe
        // carrying any vertical drift scrolled the rows while it slid them. The
        // screen was moving in two directions at once from one finger.
        //
        // The list's own recogniser is not something the swipe can outrank, so
        // the lock has to be this: once the pull has started, the list stops
        // accepting the gesture at all. This is the directional lock the
        // platform does not hand you — decided once when the pull begins, and
        // held for the rest of it.
        .scrollDisabled(interactive && backPull > 0)
        // Both keep rows abutting exactly, which the nesting guides depend on:
        // each guide is a segment drawn inside its own row, and they read as
        // one unbroken line only because consecutive rows touch. `List` would
        // otherwise impose a minimum height and inter-row spacing of its own.
        .environment(\.defaultMinListRowHeight, 0)
        .listRowSpacing(0)
        // Rows have to actually touch, or the guide segments cannot join.
        // `listRowInsets` on the row only clears the padding *inside* a cell;
        // `List` still spaces the cells apart, and that spacing is what was
        // left showing as a gap at every boundary.
        .onPreferenceChange(RowFramesKey.self) { if interactive { drag.frames = $0 } }
        // The indicator is drawn in the list's space while every frame is
        // measured globally, so the overlay records its own origin to convert
        // between the two.
        // Drawn only over the live list. Every piece of it reads the drag's
        // own geometry, so on the copy behind a swipe it would be drawing the
        // other list's answers over this one's rows.
        .overlay(alignment: .topLeading) {
            if interactive {
            GeometryReader { geo in
                ZStack(alignment: .topLeading) {
                    parentHighlight
                    dropIndicator
                    dragLabel
                }
                    .onAppear {
                        drag.origin = geo.frame(in: .global).origin
                        drag.bounds = geo.frame(in: .global)
                    }
                    .onChange(of: geo.frame(in: .global)) { _, f in
                        drag.origin = f.origin
                        drag.bounds = f
                    }
            }
            }
        }
        // The timer outlives any single gesture callback, so it is armed and
        // disarmed by the drag's existence rather than by a move event.
        .onChange(of: drag.dragging) { _, id in
            guard interactive else { return }
            if id == nil { drag.stopScrolling() } else { startScrolling(proxy) }
        }
        }
    }

    /// The bottom bar: the chip saying where a task will land, and the field.
    ///
    /// Inert behind a swipe for the same reason as a row's field — one focus
    /// state, so a second live field would fight the real one for it.
    @ViewBuilder private func captureField(for scope: NodeId?, interactive: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            // Says where the next task will land whenever that is not the
            // bottom. Without it the field drops a row into the middle of the
            // list while looking exactly as it does at rest, and a capture box
            // you cannot predict is one you stop trusting.
            //
            // The X is the way out, and it is what makes the guess affordable:
            // it only has to be right often enough to be worth one tap to undo.
            if interactive, let parent = edit.captureParent,
               let node = TreeOps.byId(tree, parent) {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.down")
                    Text("After \(node.text)").lineLimit(1)
                    Button {
                        edit.captureParent = nil
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                    }
                    .buttonStyle(.plain)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            HStack {
                let label = scope == nil ? "New project" : "Add a task"
                if interactive {
                    TextField(label, text: $edit.draft)
                        .textFieldStyle(.plain)
                        .submitLabel(.done)
                        .focused($capturing)
                        .onSubmit(commitDraft)
                } else {
                    // A drawn stand-in rather than a disabled field: what is
                    // wanted behind the swipe is the bar's shape and height, so
                    // the two screens line up as one slides off the other.
                    Text(label).foregroundStyle(.tertiary)
                }
                if interactive, !edit.draft.isEmpty {
                    Button("Add", action: commitDraft)
                }
            }
        }
        .padding(.leading, OutlineRow.columnLeft)
        .padding(.trailing, OutlineRow.railInset)
        .padding(.vertical, 10)
        .background(.bar)
        .animation(.easeOut(duration: 0.15), value: edit.captureParent)
    }


    private func title(of scope: NodeId?) -> String {
        scope.flatMap { TreeOps.byId(tree, $0)?.text } ?? "Ansa"
    }

    /// The scope the live screen is showing, for the navigation bar.
    private var title: String { title(of: scope) }

    /// The scope a back swipe lands in: one step out, or the project grid.
    private var parentScope: NodeId? {
        scope.flatMap { TreeOps.byId(tree, $0)?.parentId }
    }

    /// The rows the outline draws, flattened depth-first with a folded subtree
    /// counting as the single line it shows.
    private func rows(of scope: NodeId?) -> [(node: Node, depth: Int)] {
        var out: [(Node, Int)] = []
        func walk(_ parentId: NodeId?, _ depth: Int) {
            for child in TreeOps.childrenOf(tree, parentId) {
                out.append((child, depth))
                if !child.collapsed { walk(child.id, depth + 1) }
            }
        }
        walk(scope, 0)
        return out
    }

    /// The rows of the screen you are actually on. Everything the drag reads —
    /// order, hit-test, auto-scroll — means this one; the copy behind a back
    /// swipe draws rows but never asks questions about them.
    private var rows: [(node: Node, depth: Int)] { rows(of: scope) }

    /// Every edit goes through the store, which applies it locally and queues
    /// it for the server. Nothing here mutates the tree directly.
    private func apply(_ op: Op) {
        store.apply(op)
    }

    private func commitDraft() {
        let text = edit.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        // The id and the timestamp are minted here and carried by the op, so the
        // server applies it to exactly the node this device created.
        let id = TreeOps.newId()
        // A sibling of the row just edited, not a child of it. The complaint
        // this answers is that captured tasks pile up at the bottom, far from
        // whatever was being worked on — depth is a separate question, and
        // guessing at it would be answering one nobody asked.
        let anchor = edit.captureParent.flatMap { TreeOps.byId(tree, $0) }
        apply(.addChild(
            id: id, parentId: anchor?.parentId ?? scope, text: text,
            at: Date().timeIntervalSince1970 * 1000))
        // `addChild` appends, so the row lands at the end of its parent's
        // children and then moves up into the slot below the anchor. Two ops
        // rather than one because there is no op that inserts a *new* node at a
        // position — `insertAtDepth` moves a node that already exists.
        if let anchor,
           let i = TreeOps.childrenOf(tree, anchor.parentId)
            .firstIndex(where: { $0.id == anchor.id }) {
            apply(.moveNode(id: id, parentId: anchor.parentId, index: i + 1))
        }
        // The new row becomes the anchor, so a run of captures stacks downward
        // in the order typed instead of every one landing in the same slot and
        // reversing itself.
        edit.captureParent = id
        edit.draft = ""
    }



    private func delete(at offsets: IndexSet) {
        for index in offsets { apply(.removeNode(id: rows[index].node.id)) }
    }

    /// Open a project: zoom in, and record that it was opened.
    ///
    /// The timestamp is minted here and carried by the op, so the server stores
    /// the instant this device opened it rather than whenever the write landed.
    /// Matches `openProject` in `src/Outliner.tsx`.
    private func openProject(_ id: NodeId) {
        // A target from a different project is never the right guess.
        edit.captureParent = nil
        scope = id
        let root = TreeOps.lineageOf(tree, id).first?.id ?? id
        apply(.markOpened(id: root, at: Date().timeIntervalSince1970 * 1000))
    }

    // MARK: - Dragging

    /// The rows as the hit-test wants them: visual order, with depth.
    private var hitRows: [TreeOps.HitRow] {
        rows.map { .init(id: $0.node.id, depth: $0.depth) }
    }

    /// Row boxes in global space, in visual order, from the measured frames.
    ///
    /// Measured rather than derived from a uniform height, because a row whose
    /// text wraps is taller than one that does not — and the band arithmetic
    /// splits each row into quarters, so a wrong height puts the `into` band in
    /// the wrong place rather than merely off by a little.
    private var boxes: [TreeOps.RowBox] { drag.boxes(order: rows.map(\.node.id)) }

    /// The rows' shared left edge in global space.
    ///
    /// Any row's will do: the indent is padding *inside* the row, so every
    /// frame starts at the list's own inset whatever its depth. Taking the
    /// minimum avoids depending on which row happens to be first.
    private var rowsLeft: CGFloat { drag.rowsLeft }

    private func beginDrag(_ id: NodeId) {
        drag.begin(id)
        liftHaptic.impactOccurred()
        // Warmed for the ticks that follow. The first `impactOccurred` on a
        // cold generator is the one that arrives late, and during a drag that
        // is the tick telling you the very first target you crossed.
        haptic.prepare()
    }

    /// Re-run the hit-test for the finger's current position.
    ///
    /// Global coordinates throughout: the row frames are measured in global
    /// space and the gesture reports in it, so nothing has to know where the
    /// list begins. Only the X needs rebasing, onto the row's own left edge,
    /// because that is where the indent steps are counted from.
    private func dragMoved(_ point: CGPoint) {
        guard let dragging = drag.dragging else { return }
        drag.moved(to: point)
        let left = rowsLeft
        let next = TreeOps.dropTargetAt(
            x: Double(point.x - left),
            y: Double(point.y),
            dragging: dragging,
            tree: tree,
            visible: hitRows,
            boxes: boxes,
            guideX0: Double(OutlineRow.guideX0),
            indent: Double(OutlineRow.indent))
        // Haptic on every change of target, not just of depth: crossing from a
        // nest into a gap is as much a change of meaning as changing level, and
        // the indicator moves for both.
        if next != drag.target { haptic.impactOccurred(intensity: 0.6) }
        drag.target = next
    }

    /// Arm edge scrolling for this drag. The controller owns the tick; the
    /// view supplies the two things that need the tree: the current row order,
    /// re-read each tick because the tree can change under a drag, and the
    /// hit-test to re-run once the rows have moved.
    private func startScrolling(_ proxy: ScrollViewProxy) {
        drag.startScrolling(
            proxy,
            order: { rows.map(\.node.id) },
            onScroll: { dragMoved(drag.point) })
    }

    /// Release: apply the drop, then clear every piece of drag state together.
    private func endDrag() {
        defer { drag.end() }
        guard let dragging = drag.dragging, let target = drag.target,
              let op = TreeOps.dropOp(tree, dragging, target, scope: scope) else { return }
        // Landed. Distinct from the ticks along the way, so a release that
        // moved something feels different from one that let go over nothing.
        liftHaptic.impactOccurred(intensity: 0.7)
        apply(op)
    }

    /// The name of the row in flight, riding with the finger.
    ///
    /// The row itself stays put and fades, so without this the only thing
    /// naming what is being carried is a gap in the list — and once the drag
    /// scrolls, the faded row is not even on screen. The chip is the answer to
    /// "what am I holding" and the indicator answers "where will it go".
    ///
    /// Offset above the touch rather than under it: the finger covers roughly a
    /// row's height of screen, which is exactly the space a label under it
    /// would occupy.
    @ViewBuilder private var dragLabel: some View {
        if let id = drag.dragging, let node = tree.first(where: { $0.id == id }) {
            Text(node.text.isEmpty ? "Untitled" : node.text)
                .lineLimit(1)
                .font(.callout.weight(.medium))
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(
                    Capsule().fill(.regularMaterial))
                .overlay(Capsule().strokeBorder(DropPalette.insert.opacity(0.5), lineWidth: 1))
                .shadow(radius: 6, y: 2)
                // Pinned to the left rather than tracking the finger's x: the
                // chip is an identity label, not a second cursor, and one that
                // slides sideways competes with the indicator for the answer
                // to where the drop lands.
                .frame(maxWidth: 240, alignment: .leading)
                .offset(x: 16, y: drag.point.y - drag.origin.y - 46)
                .allowsHitTesting(false)
                .transition(.opacity)
        }
    }

    /// The guide segments this row draws: one thin bar per ancestor whose
    /// subtree the row is inside.
    ///
    /// Highlighted rather than the whole line when a drop would land under that
    /// parent — each row lights its own piece, and together they light the run.
    /// - Parameter rows: the list this row belongs to. Passed rather than read
    ///   from `rows`, so the copy behind a back swipe draws its own guides
    ///   instead of the other screen's — the two scopes have different depths,
    ///   and a guide is a statement about the list it is drawn in.
    @ViewBuilder private func guideSegments(
        for id: NodeId, in rows: [(node: Node, depth: Int)]
    ) -> some View {
        if let i = rows.firstIndex(where: { $0.node.id == id }) {
            let all = TreeOps.guides(rows.map { .init(id: $0.node.id, depth: $0.depth) })
            // A parent normally draws no segment of its own guide — the run
            // starts at its first child. While lit it draws the bottom half of
            // one, so the line leaves the highlighted row instead of starting a
            // row below it with a gap in between.
            let here = TreeOps.guidesThrough(all, at: i)
            let stub = all.first { $0.parent == litGuideParent && $0.first == i + 1 }
            // A segment fills its row's full height, top edge to bottom edge.
            // The row carries its own spacing and `List` adds none, so
            // consecutive rows touch and the segments abut into one unbroken
            // line — with no constant to get wrong on a device whose `List`
            // insets rows differently.
            //
            // Measured rather than declared, since a row whose text wraps is
            // taller. The fallback covers only a row not yet measured, which
            // corrects itself on the next layout pass.
            //
            // Rectangle, not Capsule: rounded ends on a segment meant to join
            // the next one pinch the join into a visible waist.
            let h = drag.frames[id]?.height
                ?? (OutlineRow.rowHeight + OutlineRow.rowPadding)
            ZStack(alignment: .topLeading) {
                ForEach(here, id: \.parent) { guide in
                    let lit = guide.parent == litGuideParent && i < litUntilRow
                    Rectangle()
                        .fill(lit
                            ? DropPalette.nest.opacity(0.45)
                            : Color.primary.opacity(0.12))
                        .frame(width: lit ? 2.5 : 1.5, height: h)
                        .offset(x: OutlineRow.guideX0
                            + CGFloat(guide.depth) * OutlineRow.indent - 0.75)
                        .animation(.easeOut(duration: 0.12), value: lit)
                }
                if let stub, i < litUntilRow {
                    Rectangle()
                        .fill(DropPalette.nest.opacity(0.45))
                        .frame(width: 2.5, height: h / 2)
                        .offset(x: OutlineRow.guideX0
                            + CGFloat(stub.depth) * OutlineRow.indent - 1.25,
                            y: h / 2)
                }
            }
            .frame(height: h, alignment: .topLeading)
        }
    }

    /// The row whose guide the dragged row would hang from, or nil when no gap
    /// drop is live.
    ///
    /// Identified by node, not by depth. Depth alone matches every guide on
    /// that level — all of the future parent's siblings light up alongside it,
    /// which says the row could land under any of them. `parentAtDepth` walks
    /// the same lineage `insertAtDepth` walks to choose the real parent, so the
    /// lit guide and the landing place cannot disagree.
    ///
    /// The parent a drop would land under, for every drop that has one.
    ///
    /// Both the guide and the parent row light from this, in both modes. They
    /// are one answer shown twice rather than two answers: the row names the
    /// parent, and the line traces the run the drop joins — so a drag knows
    /// where it is landing even when the parent has scrolled off, which is the
    /// common case in a deep tree.
    ///
    /// A drop at depth 0 lights nothing, which is correct rather than missing:
    /// a root row has no parent, so there is no guide it could hang from, and
    /// the insertion line's x is the only depth cue at that level.
    private var litGuideParent: NodeId? {
        guard let target = drag.target else { return nil }
        switch target.mode {
        case .return:
            // The row goes back where it started, so nothing is a target.
            return nil
        case .into:
            // Nesting into a row makes that row the parent.
            return target.id
        case .before, .after:
            guard let d = target.depth else { return nil }
            return TreeOps.parentAtDepth(tree, target.id, d, scope)
        }
    }

    /// Whether the drop would land directly under the project itself.
    ///
    /// Depth 0 is the one drop with no parent row to light: the project is the
    /// parent, and it is not in the list. So it lights the scope strip above
    /// the list instead — the one element on screen that stands for the root.
    ///
    /// Read off the depth rather than off `litGuideParent`, because that
    /// answers with the scope id, which is `nil` at the top level and so cannot
    /// be told apart from no drop at all.
    private var litRoot: Bool {
        guard let target = drag.target else { return false }
        switch target.mode {
        case .return: return false
        case .into: return false
        case .before, .after: return target.depth == 0
        }
    }

    /// The deepest indent the current gap will accept.
    ///
    /// The indicator marks the depth the finger picked; this is the far end of
    /// the range it can pick from. Without it the line's right end is just the
    /// screen edge and says nothing, so a drag has no way to know it has run
    /// out of depth short of pushing further right and watching nothing happen.
    ///
    /// `.after` anchors to the row above the gap, `.before` to the row below —
    /// which for `.before` means there is no row above at all, the only case
    /// that reaches it.
    private func deepestAtTarget(_ target: TreeOps.DropTarget) -> Int? {
        guard target.mode == .before || target.mode == .after else { return nil }
        guard target.mode == .after else { return 0 }
        guard let above = hitRows.first(where: { $0.id == target.id }) else { return nil }
        // Same exclusion as the hit-test: the row in flight is leaving, so it
        // does not make its parent a parent.
        let hasKids = TreeOps.childrenOf(tree, above.id).contains { $0.id != drag.dragging }
        return TreeOps.deepestAtGap(
            aboveDepth: above.depth, belowDepth: nil, aboveHasChildren: hasKids)
    }

    /// The first row index the lit guide does *not* reach.
    ///
    /// A guide's run spans the whole subtree, but only the part from the parent
    /// down to the insertion point is the path the dropped row would take. The
    /// rest is subtree that happens to sit on the same line and has nothing to
    /// do with this drop — lighting it says the row might land anywhere in
    /// there.
    ///
    /// Cutting it at the drop point makes the lit length itself the answer: the
    /// line reaches from the parent to exactly where the row is going, which is
    /// the same shape the insertion indicator gives a depth-0 drop.
    ///
    /// `.into` is not cut. Nesting into a row lights that row rather than a
    /// guide — the row has no run yet to truncate — and `parentHighlight`
    /// carries the case on its own.
    private var litUntilRow: Int {
        guard let target = drag.target,
              target.mode == .before || target.mode == .after,
              let i = rows.firstIndex(where: { $0.node.id == target.id })
        else { return .max }
        // `.before` lands above its anchor row, `.after` below it.
        return target.mode == .before ? i : i + 1
    }

    // A depth-0 drop deliberately draws no vertical line. There was one, running
    // from the top of the list down to the insertion point, on the reasoning
    // that every other depth gets a line and the shallowest drop should not be
    // the least confirmed. But it had to sit at `guideX0` — the same x a
    // depth-0 row's own guide uses — so the one line stood for two different
    // levels at once, and reading it meant guessing which. The lit scope strip
    // says the same thing without the ambiguity: it is the project, which is
    // exactly the parent a depth-0 drop lands under.

    /// The parent the drop would land under, filled and outlined.
    ///
    /// Drawn for a gap drop as well as a nest, so the parent and its guide
    /// light together. Skipped when the parent is off screen or is the scope
    /// itself — the guide still runs down the visible rows and carries the
    /// answer on its own.
    ///
    /// Filled as well as outlined: an outline alone reads as a hairline at
    /// arm's length, and it has to beat a guide line running through the row.
    @ViewBuilder private var parentHighlight: some View {
        if let id = litGuideParent, let frame = drag.frames[id] {
            let left = rowsLeft - drag.origin.x
            RoundedRectangle(cornerRadius: 6)
                .fill(DropPalette.nest.opacity(0.14))
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(DropPalette.nest, lineWidth: 2))
                .frame(width: frame.width, height: frame.height)
                .offset(x: left, y: frame.minY - drag.origin.y)
        }
    }

    /// The line showing where the row would land, drawn over the list.
    ///
    /// A gap shows a line indented to the depth the finger picked — that indent
    /// is the only thing distinguishing "sibling" from "child" at the same
    /// gap. Nesting draws no line, having no gap to draw in; `parentHighlight`
    /// carries that case, and lights the same parent for both.
    @ViewBuilder private var dropIndicator: some View {
        if let target = drag.target, let frame = drag.frames[target.id] {
            // Same rebase as the guides: row frames are global, the overlay
            // starts at the list's edge, and `List` insets the rows past it.
            let left = rowsLeft - drag.origin.x
            switch target.mode {
            case .into:
                // Nothing here: nesting is drawn by `parentHighlight`, which
                // lights the same row for a gap drop under the same parent.
                // Drawing it here too would double the fill on that row.
                EmptyView()
            case .before, .after:
                let x = left + OutlineRow.guideX0
                    + CGFloat(target.depth ?? 0) * OutlineRow.indent
                // The row frame is the whole cell now — the row owns its
                // spacing and `List` adds no insets — so its edges already are
                // the boundary between two rows, with nothing to add.
                let edge = target.mode == .before ? frame.minY : frame.maxY
                let y = edge - drag.origin.y
                // Centred on that boundary, so it sits in the whitespace
                // between the two rows and belongs to neither. Drawn a row
                // boundary away from where it belongs, the line reads as
                // "between the wrong two rows" — off by one row is the whole
                // question a drop indicator exists to answer.
                let thickness: CGFloat = 3
                // The range the finger can pick from, drawn faint under the
                // line itself: left tick at depth 0, right tick at the deepest
                // this gap allows. The bright line says where the row lands
                // now; the ticks say how much further either way there is to
                // go. They matter more since the deep end became conditional —
                // it is no longer "one past the row above" everywhere, so it
                // cannot be inferred from the tree's shape at a glance.
                if let deepest = deepestAtTarget(target) {
                    let x0 = left + OutlineRow.guideX0
                    let xN = x0 + CGFloat(deepest) * OutlineRow.indent
                    Capsule()
                        .fill(DropPalette.insert.opacity(0.28))
                        .frame(width: max(thickness, xN - x0), height: thickness)
                        .offset(x: x0, y: y - thickness / 2)
                    ForEach([x0, xN], id: \.self) { tick in
                        Capsule()
                            .fill(DropPalette.insert.opacity(0.55))
                            .frame(width: 2, height: 11)
                            .offset(x: tick - 1, y: y - 5.5)
                    }
                }
                Capsule()
                    .fill(DropPalette.insert)
                    .frame(width: max(0, frame.width - OutlineRow.guideX0
                        - CGFloat(target.depth ?? 0) * OutlineRow.indent),
                           height: thickness)
                    .offset(x: x, y: y - thickness / 2)
                // The dot marks where the line meets the guide it would hang
                // from, which is the one thing a thumb covering the line's
                // left end would otherwise hide. Drawn after the line so it
                // sits on top of it rather than under.
                Circle()
                    .fill(DropPalette.insert)
                    .frame(width: 7, height: 7)
                    .offset(x: x - 3.5, y: y - 3.5)
            case .return:
                EmptyView()
            }
        }
    }

    /// Start renaming a row, seeding the field with what is already there.
    ///
    /// The focus has to wait a turn. `editing` is what causes the TextField to
    /// exist at all, so focusing in the same pass targets a field that has not
    /// been built yet — the write lands on nothing, the field comes up
    /// unfocused, and the focus-loss commit tears the edit down before it
    /// starts.
    private func beginEdit(_ node: Node) {
        edit.begin(node)
        DispatchQueue.main.async { focusedRow = node.id }
    }

    /// Finish renaming. `AnsaCore.commitEdit` decides whether that is a rename,
    /// a delete, or nothing at all — the same rule the web applies, so a row
    /// emptied on the phone disappears exactly as it would in the browser.
    ///
    /// Both Return and tapping away land here: on the phone they mean the same
    /// thing. Return used to open a fresh row below, the way the web still
    /// does, but the phone has a permanent "Add a task" field — so that was a
    /// second route to one outcome, and it cost a keyboard dismiss-and-reopen
    /// as focus jumped to the new row.
    ///
    /// - Parameter from: the row the caller believes it is committing. A blur
    ///   arrives after the field has gone, so by then `editing` may already
    ///   name a different row; committing that one would end an edit the user
    ///   just started.
    private func commitEdit(from: NodeId? = nil) {
        guard edit.shouldCommit(from: from), let id = edit.editing else { return }
        let op = TreeOps.commitEdit(tree, id, edit.text)
        if let op { apply(op) }

        // Remember it only if it still exists: an emptied row is deleted by
        // `commitEdit`, and anchoring to a node that just went away would send
        // the new task back to the bottom with the chip still claiming
        // otherwise.
        edit.endEdit(rememberAnchor: TreeOps.byId(tree, id) == nil ? nil : id)
        focusedRow = nil
    }

    private func confirmDeleteProject(_ id: NodeId) {
        pendingDelete = TreeOps.byId(tree, id)
    }

    /// Edge-swipe right to leave the current scope.
    ///
    /// The thresholds are deliberately loose in one direction and tight in the
    /// other: it must start within a thumb's width of the edge, but once it
    /// does, a short pull is enough. A gesture that demands a long drag from a
    /// precise spot is one people stop trying after it fails twice.
    ///
    /// Vertical distance is checked so a scroll that begins near the edge is
    /// not read as a back swipe.
    private var zoomOutSwipe: some Gesture {
        DragGesture(minimumDistance: 20, coordinateSpace: .local)
            .onChanged { g in
                guard armed(g) else { return }
                // Rubber-banded rather than one-to-one past the threshold: the
                // pull keeps responding so the gesture never feels dead, while
                // the slowing says the useful part of it is already done.
                let d = g.translation.width
                backPull = d <= backThreshold
                    ? d
                    : backThreshold + (d - backThreshold) * 0.35
            }
            .onEnded { g in
                guard armed(g), g.translation.width > backThreshold else {
                    // Short of the threshold: back where it came from, which is
                    // what tells you the gesture was seen and declined.
                    withAnimation(.easeOut(duration: 0.22)) { backPull = 0 }
                    return
                }
                // Carry it the rest of the way out before swapping, so the view
                // leaves rather than snapping back while the new scope appears
                // underneath — that reads as the gesture failing at the moment
                // it actually succeeded.
                //
                // The reset is unanimated and rides with the scope change, so
                // the incoming view is already in place the frame it appears.
                withAnimation(.easeOut(duration: 0.18)) { backPull = slideOut }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
                    var t = Transaction()
                    t.disablesAnimations = true
                    withTransaction(t) {
                        zoomOut()
                        backPull = 0
                    }
                }
            }
    }

    /// What sits behind the view while a back swipe lifts it aside.
    ///
    /// Drawn only during the swipe: at rest it is covered anyway, and keeping
    /// it out of the tree the rest of the time means it can never leak around
    /// the edges of a view that is exactly where it belongs.
    /// The shade the revealed screen sits under.
    ///
    /// Once was the whole backdrop: a coloured panel and a label standing in
    /// for a screen that was not being drawn. The screen is real now, so the
    /// stand-in is gone and only the shading is left — a revealed screen at
    /// full brightness reads as sitting *beside* the one being moved rather
    /// than behind it, and this is what puts it back underneath.
    @ViewBuilder private var backdrop: some View {
        // Gated on the pull, not just dimmed by it. The shade is drawn at
        // `1 - t`, so at rest it is at *full* strength — left in the tree
        // unguarded it does not sit dormant waiting for a swipe, it sits there
        // black.
        if backPull > 0 {
            // How far through the useful part of the pull we are, 0...1.
            let t = min(1, Double(backPull) / Double(backThreshold))
            // Darkest at the left edge, where the gap has been open longest.
            // The eye reads the lightening as the screen arriving.
            //
            // Deeper than it looks like it needs to be, because of dark mode.
            // Black over a near-black ground has very little room to work: the
            // shade that reads clearly on white is close to invisible there,
            // and the revealed screen came up looking un-shaded. The strength
            // here is set by what dark mode needs; light mode has plenty of
            // contrast to spare either way.
            //
            // `1 - t` squared rather than linear, so the shade holds its depth
            // through the early part of the pull and then lifts quickly. Linear
            // spent most of its range already half-faded — the point of the
            // shade is to be *there* when the gap first opens.
            // Held rather than faded: `1 - t` cubed keeps the shade near full
            // strength through the first half of the pull and drops it late.
            // The earlier curves spent their range too early, so by the time
            // the gap was wide enough to look into, the thing meant to be
            // shading it had already mostly gone.
            let k = pow(1 - t, 3)
            LinearGradient(
                colors: [.black.opacity(0.78 * k), .black.opacity(0.34 * k)],
                startPoint: .leading, endPoint: .trailing)
                .ignoresSafeArea()
                .allowsHitTesting(false)
        }
    }

    /// How far the view must travel before letting go zooms out.
    private let backThreshold: CGFloat = 60

    /// Far enough right to be clear of the screen on any phone.
    private let slideOut: CGFloat = 700

    /// Whether this drag is a back swipe rather than a scroll or a row action.
    ///
    /// Must start within a thumb's width of the edge, so it never races the
    /// `swipeActions` the rows carry, and must be going sideways rather than
    /// down, so a scroll beginning near the edge is left alone.
    ///
    /// This decides whether the swipe *acts*, not whether it is recognised —
    /// see the attachment site. Everything here is deliberately cheap and
    /// side-effect free, because it runs on every drag anywhere on screen.
    private func armed(_ g: DragGesture.Value) -> Bool {
        scope != nil
            // Not while a row is in the air. The two gestures are recognised
            // simultaneously, so without this a swipe can begin under a drag
            // that is already running and the row would follow a finger that
            // is busy moving the whole screen out from under it.
            && !drag.isActive
            && g.startLocation.x < 32
            && goingSideways(g)
    }

    /// Whether the finger is travelling sideways rather than down.
    ///
    /// Not `abs(height) < abs(width)`. That was the test, and it is far
    /// stricter than it looks: it is evaluated on the *first* callback, 20pt
    /// into the gesture, and a thumb coming off the bezel arcs — the opening
    /// movement of a perfectly good swipe often carries more vertical than
    /// horizontal. One early sample then disqualified the whole thing, which is
    /// why the swipe had to be aimed to work at all.
    ///
    /// Two changes. The comparison is against a fraction of the width, so a
    /// swipe is allowed to drift while still reading as sideways; and once the
    /// pull is running it stays running, since a gesture that has visibly begun
    /// should not be revoked by a wobble halfway through.
    private func goingSideways(_ g: DragGesture.Value) -> Bool {
        if backPull > 0 { return true }
        return g.translation.width > 0
            && abs(g.translation.height) < abs(g.translation.width) * 1.5
    }

    private func zoomOut() {
        // Zooming out changes what the field means, so the guess goes with it.
        edit.captureParent = nil
        scope = parentScope
    }
}

/// One bar for the whole scope, the way the web app does it.
///
/// Blue while there is work left, green at 100% — the colour change is the
/// point, since a full bar and a nearly-full one are hard to tell apart at 4pt
/// tall.
private struct ScopeProgress: View {
    let progress: TreeOps.Progress
    /// The project's own name. Shown only while a drag is running, so the
    /// strip is something a drop can land *on* rather than an unlabelled bar —
    /// without it the highlight lights a measurement, and a measurement is not
    /// a parent.
    ///
    /// The rest of the time it is the navigation title one line above, and
    /// saying it twice bought nothing. The counts take the space instead.
    let title: String
    /// A drop at depth 0 would land as a top-level task in this project. Not
    /// nesting into the project the way one row nests into another — the
    /// project is the list, not a task in it — but it is the same question a
    /// drag is asking, so it gets the same answer.
    let lit: Bool

    private var complete: Bool { progress.pct == 100 }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Two jobs, one line. Under a drag it names what a drop would land
            // in; otherwise it says how much is left, which is the one thing
            // the bar beside it cannot — 70% of three tasks and 70% of three
            // hundred draw identically and mean nothing alike.
            HStack(spacing: 6) {
                Text(lit ? "Drop into \(title)" : "\(progress.done) of \(progress.total) done")
                    .lineLimit(1)
                    .foregroundStyle(
                        lit ? AnyShapeStyle(DropPalette.nest) : AnyShapeStyle(.secondary))

                if !lit {
                    Spacer(minLength: 0)
                    // Kept, but moved up beside the counts rather than sitting
                    // in its own column next to the bar. It is the exact figure
                    // the bar can only approximate, and it costs no height
                    // here. Gone under a drag, where the line has a louder job.
                    Text("\(progress.pct)%")
                        .foregroundStyle(
                            complete ? AnyShapeStyle(Color.green) : AnyShapeStyle(.tertiary))
                }
            }
            .font(.subheadline.weight(.medium))
            .monospacedDigit()
            .contentTransition(.numericText())

        HStack(spacing: 10) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(.quaternary)
                    Capsule()
                        .fill(complete ? Color.green : Color.accentColor)
                        .frame(width: geo.size.width * CGFloat(progress.pct) / 100)
                }
            }
            .frame(height: 4)
        }
        }
        .padding(.leading, OutlineRow.columnLeft)
        .padding(.trailing, OutlineRow.railInset)
        .padding(.vertical, 8)
        // Same fill and outline a lit parent row gets, so "this becomes the
        // parent" looks the same whether the parent is a row or the project.
        // Drawn as a background rather than an overlay: the strip is a real
        // element, not something floating over the list.
        .background {
            if lit {
                RoundedRectangle(cornerRadius: 6)
                    .fill(DropPalette.nest.opacity(0.14))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .strokeBorder(DropPalette.nest, lineWidth: 2))
                    .padding(.horizontal, 8)
            }
        }
        .animation(.easeOut(duration: 0.35), value: progress.pct)
        .animation(.easeOut(duration: 0.12), value: lit)
    }
}

/// A quiet strip explaining a sync problem, rather than an alert.
///
/// Not modal on purpose: none of these states stop the user working, and a
/// dialog demanding acknowledgement for something they cannot act on is worse
/// than the problem it reports.
private struct SyncBanner: View {
    let text: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "antenna.radiowaves.left.and.right.slash")
            Text(text)
            Spacer()
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .padding(.leading, OutlineRow.columnLeft)
        .padding(.trailing, OutlineRow.railInset)
        .padding(.vertical, 8)
        .background(.quaternary)
    }
}

/// One row: checkbox, bullet, text. Progress moved to a single bar for the
/// whole scope, matching the web app, which never showed a count per row.


private struct OutlineRow: View {
    let node: Node
    let depth: Int
    let hasChildren: Bool
    let editing: Bool
    @Binding var editText: String
    @FocusState.Binding var focusedRow: NodeId?
    let onToggleDone: () -> Void
    let onCollapse: () -> Void
    let onBeginEdit: () -> Void
    let onBlur: (NodeId) -> Void
    let onSubmit: () -> Void
    /// Drag, reported in global coordinates. The row does not know where the
    /// list starts, so the view that owns the hit-test rebases these.
    let onDragBegan: () -> Void
    let onDragMoved: (CGPoint) -> Void
    let onDragEnded: () -> Void
    /// True while this row is the one being carried, which dims it in place.
    let isDragging: Bool

    /// Whether the press completed and the drag took over. See `bulletGesture`.
    @State private var armed = false

    /// The bullet's gestures: a tap folds, a long press arms a drag.
    ///
    /// Two recognizers combined with `.simultaneously`, not one sequenced
    /// gesture that decides on release. A sequenced gesture whose first stage
    /// never completes *fails* rather than ending, so its `onEnded` never runs
    /// and a tap is simply swallowed — which is what broke folding. And a
    /// Button underneath cannot serve the tap either, because the drag has to
    /// take the touch with `.highPriorityGesture` to see a drag at all, and
    /// taking it is precisely what stops the Button firing.
    ///
    /// Simultaneous recognition lets the tap end on its own while the press
    /// runs in parallel. They cannot both fire: a tap that lasted long enough
    /// to arm the drag is no longer a tap.
    private var bulletGesture: some Gesture {
        TapGesture()
            .onEnded { if !armed && hasChildren { onCollapse() } }
            .simultaneously(with: dragGesture)
    }

    /// Long-press to arm, then drag.
    ///
    /// The press delay is what keeps a drag from starting on every scroll that
    /// happens to begin over a bullet; `armed` is what tells the tap above that
    /// this one won.
    private var dragGesture: some Gesture {
        LongPressGesture(minimumDuration: 0.35)
            .sequenced(before: DragGesture(coordinateSpace: .global))
            .onChanged { value in
                switch value {
                case .first:
                    break
                case .second(_, let drag):
                    guard let drag else {
                        armed = true
                        onDragBegan()
                        return
                    }
                    onDragMoved(drag.location)
                }
            }
            .onEnded { _ in
                guard armed else { return }
                armed = false
                onDragEnded()
            }
    }

    /// One indent step, and the spacing between two depth guides.
    ///
    /// The guides are what set it: at 12pt four levels read as a hatch rather
    /// than four rails, and the guide is the only thing on screen that says
    /// which depth a row sits at. The cost is label width at every level — depth 4 starts 164pt into
    /// a 390pt screen — which is a deliberate nudge toward zooming into a
    /// subtree rather than nesting deeply in place.
    ///
    /// Not private: the drag hit-test has to count indent steps in exactly the
    /// units the row draws them in, and a second copy of these numbers is how
    /// the indicator ends up pointing at a different level than the drop.
    static let indent: CGFloat = 20

    /// X of depth 0 — the centre of the bullet column, which is where a depth
    /// guide runs.
    ///
    /// The bullet leads the row, so this is half a mark rather than the full
    /// width of two columns it used to be. That is the whole reason the bullet
    /// and the checkbox swapped: a guide through bullet centres is only a
    /// straight line if nothing else shares that column.
    ///
    /// Measured from the list's leading edge, not the row's content box, so it
    /// carries `railInset`. The guides are drawn in the list's coordinate space
    /// while the inset is padding *inside* each row — nothing propagates it
    /// across, so it has to be part of this number or every line sits a rail's
    /// width left of the bullets it is supposed to run through.
    static let guideX0: CGFloat = railInset + 16

    /// X of the bullet column's left edge — where the bars above and below the
    /// outline start, so the column reads as sitting on one vertical line.
    ///
    /// The *ring*'s edge, not the dot's. A leaf row shows only the 6pt dot, but
    /// a parent draws an 18pt ring around it, and a collapsed one fills that
    /// ring solid. Aligning to the dot at 30 would leave that ring hanging 6pt
    /// out into the margin — which is the one thing the line is there to stop.
    /// So the bars sit at the widest mark the column can ever draw, and nothing
    /// crosses to the left of them.
    static let columnLeft: CGFloat = railInset + (32 - 18) / 2

    /// How far the whole row sits in from the screen's leading edge.
    ///
    /// `listRowInsets` is zeroed so the row frame is the entire cell — that is
    /// what lets a guide segment fill its row and meet the ones above and below
    /// — but it zeroed the leading margin along with everything else, leaving
    /// the bullet almost against the bezel.
    ///
    /// The value is the row's own internal rhythm applied to its outside edge:
    /// the gap from the bullet's disk to the checkbox is 13pt of empty bullet
    /// frame, the 10pt stack spacing, and 6.5pt of empty checkbox frame — about
    /// 30pt. Matching it here means the first mark is as far from the edge as it
    /// is from its neighbour, so nothing in the row is more crowded than the
    /// rest of it. The disk sits 13pt into its own frame, so the padding is the
    /// remainder.
    static let railInset: CGFloat = 17

    /// A single-line row's content height, without the row's own vertical
    /// padding. Only a fallback for a row `List` has not measured yet — the
    /// guide segments use the real frame, since a wrapped row is taller.
    static let rowHeight: CGFloat = 40

    /// The row's own vertical spacing, split evenly above and below its
    /// content. Declared here rather than left to `List`: with the row insets
    /// zeroed, the row frame is the whole cell, which is what lets a guide
    /// segment fill its row and still meet the segments above and below.
    static let rowPadding: CGFloat = 22

    var body: some View {
        HStack(spacing: 10) {
            // Square, where the bullet is round. Both marks used to be circles
            // differing by fill and colour — the same two channels that carry
            // *state* — so a ticked box and a collapsed parent's bullet
            // converged on one mark meaning two things in adjacent columns.
            // Shape is categorical: it says what the control is, whatever state
            // it happens to be in, which leaves fill free to mean only "done".
            // Tapping the bullet folds, rather than zooming as it did before.
            // Zoom moved to a swipe: it is cheap to undo but replaces the whole
            // screen, and this column sits where a thumb brushes while
            // scrolling. What is left here is undone by repeating the tap.
            Bullet(hasChildren: hasChildren, collapsed: node.collapsed)
                // The dot is 6pt; a tap target has to be a finger wide
                // regardless, so the frame is padded out rather than the
                // mark drawn larger.
                .frame(width: 32, height: 40)
                .contentShape(Rectangle())
                // High priority, not `.gesture`: a plain gesture loses the
                // touch to the List's own scroll, so a real finger on the
                // bullet scrolls the page and the drag never arms. (Injected
                // touches in a simulator skip that arbitration, which is why
                // this looked like it worked.) Both the fold and the drag live
                // in there — see `bulletGesture`.
                .highPriorityGesture(bulletGesture)

            Button(action: onToggleDone) {
                Checkbox(done: node.done)
                    .frame(width: 32, height: 40)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            // Tap the label to rename in place. The field replaces the text
            // rather than sitting beside it, so the row does not reflow when
            // editing starts and the words stay exactly where they were.
            Group {
                if editing {
                    TextField("", text: $editText, axis: .vertical)
                        .textFieldStyle(.plain)
                        .focused($focusedRow, equals: node.id)
                        .submitLabel(.done)
                        // Return commits and dismisses. It goes through
                        // onSubmit rather than the focus-loss commit so the
                        // two paths stay distinguishable — blur can also be a
                        // tap onto another row, which commits the same way but
                        // is not the user saying they are finished.
                        .onSubmit(onSubmit)
                        // A vertical-axis TextField can also take Return as a
                        // literal newline — from paste, or a keyboard onSubmit
                        // does not cover. Rows are one line of text
                        // conceptually; the axis exists only so long text wraps
                        // instead of scrolling sideways.
                        .onChange(of: editText) { _, text in
                            guard text.contains("\n") else { return }
                            editText = text.replacingOccurrences(of: "\n", with: "")
                            onSubmit()
                        }
                        // Losing focus is what "tapped away" looks like:
                        // another row, the capture field, or the keyboard's
                        // dismiss. onDisappear cannot serve here — by the time
                        // the field is torn down the commit has usually already
                        // run and cleared the state it needs.
                        //
                        // Only a true→false transition commits. The field is
                        // born unfocused and gains focus a beat later, so
                        // reacting to the initial false would end the edit on
                        // the frame it began.
                        .onChange(of: focusedRow) { was, now in
                            guard was == node.id, now != node.id else { return }
                            onBlur(node.id)
                        }
                } else {
                    // A Button, not `.onTapGesture` — inside a List row the
                    // bare tap gesture never fires, while the checkbox and
                    // bullet beside it, both plain Buttons, work.
                    //
                    // The frame goes *inside* the contentShape. Reversed, the
                    // shape is taken from the text's own size and the space
                    // past a short word stays dead, which is most rows.
                    Button(action: onBeginEdit) {
                        Text(node.text)
                            .strikethrough(node.done)
                            .foregroundStyle(node.done ? .secondary : .primary)
                            .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            // Without this the last word runs under the screen edge. The
            // list's own inset is spent on the leading marks, and a row
            // that wraps takes every point it is given.
            .padding(.trailing, 4)
        }
        .padding(.leading, Self.railInset + CGFloat(depth) * Self.indent)
        // No row separators. The desktop has none — rows are told apart by
        // whitespace and the hover background, and the vertical guides are the
        // only lines in the outline. `List` draws them by default, so they have
        // to be turned off rather than left out.
        .listRowSeparator(.hidden)
        // Faded to a ghost while it is being carried, so the row under the
        // finger is visibly the one in flight and not just another row the
        // indicator happens to sit near. It stays in place rather than
        // following the finger: the tree still has to be readable to aim at,
        // and a row lifted out of it would take its own gap with it.
        .opacity(isDragging ? 0.35 : 1)
        .animation(.easeOut(duration: 0.12), value: isDragging)
        // Outlined, not just washed. A 6% fill of `Color.primary` was the whole
        // mark before, and in dark mode that is near-white at 6% over near-black
        // — a couple of levels off the background, which is nothing. A stroke
        // reads at far lower contrast than a wash does, so the same faint grey
        // that vanishes as a fill still draws a legible edge. The fill stays,
        // raised a little, because an outline alone around 35%-faded content
        // reads as an empty box rather than a row that is elsewhere.
        //
        // `.secondary` rather than a fixed grey: it is the one colour that is
        // already a muted version of the foreground in both themes, so the
        // outline sits at the same remove from the text on black and on white.
        .listRowBackground(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(isDragging ? Color.primary.opacity(0.09) : .clear)
                .strokeBorder(
                    isDragging ? Color.secondary.opacity(0.55) : .clear,
                    lineWidth: 1)
                // Inset so the border is inside the row rather than butting
                // against the one above it, and clear of the guides at x=16.
                .padding(.horizontal, 6)
                .padding(.vertical, 1))
        // No `.contentShape(Rectangle())` here. It makes the whole row a single
        // hit-test target, which swallows taps before they reach the checkbox
        // and the bullet — separate targets are the point of the row. Add it
        // only alongside a row-level tap action, never on its own.
    }

}

/// The done control: a rounded square, filled with a tick once done.
private struct Checkbox: View {
    let done: Bool

    var body: some View {
        RoundedRectangle(cornerRadius: 5)
            .strokeBorder(done ? AnyShapeStyle(.clear) : AnyShapeStyle(.secondary), lineWidth: 2)
            .background(
                RoundedRectangle(cornerRadius: 5)
                    .fill(done ? AnyShapeStyle(.tint) : AnyShapeStyle(.clear)))
            .frame(width: 19, height: 19)
            .overlay {
                if done {
                    Image(systemName: "checkmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(.background)
                }
            }
    }
}

/// The node mark, in the web app's three states: a bare dot for a leaf, a ring
/// around the dot for an expanded parent, a solid disc for a collapsed one.
///
/// The states differ in *shape*, so they read with no colour information at
/// all. The dot stays the brightest part throughout because the dot is the drag
/// handle — the ring or disc is context around it.
private struct Bullet: View {
    let hasChildren: Bool
    let collapsed: Bool

    var body: some View {
        ZStack {
            if hasChildren {
                if collapsed {
                    // The disc is now the only thing saying children are hidden
                    // here — both the chevron and the count came off the row.
                    Circle()
                        .fill(.secondary)
                        .frame(width: 18, height: 18)
                } else {
                    Circle()
                        .strokeBorder(.secondary, lineWidth: 2)
                        .frame(width: 18, height: 18)
                }
            }
            Circle()
                .fill(.primary)
                .frame(width: 6, height: 6)
        }
        .frame(width: 18, height: 18)
    }
}


/// The projects overview: one row per project.
///
/// Cards two-to-a-row came first and read well, but left delete with nowhere to
/// go — it is hover-driven on the web, and a grid cell has no standard gesture
/// for it. Full-width rows get `.swipeActions`, which is the platform's answer
/// and the same gesture the outline rows already use. Density is the trade: five
/// projects to a screen rather than ten, bought back a little by names no longer
/// wrapping.
private struct ProjectGrid: View {
    let tree: Tree
    /// Whether the server has answered yet. Without it an empty list is
    /// ambiguous, and the app resolved the ambiguity the alarming way: a launch
    /// that had not finished asking announced "No projects yet" over what was
    /// about to become a full list.
    let loaded: Bool
    let onOpen: (NodeId) -> Void
    let onDelete: (NodeId) -> Void

    private var projects: [Node] { TreeOps.projectList(tree) }

    var body: some View {
        if projects.isEmpty {
            if loaded {
                ContentUnavailableView(
                    "No projects yet",
                    systemImage: "tray",
                    description: Text("Start one below."))
            } else {
                // Only reachable on a genuine cold start — with a cached tree
                // there are already projects to draw. Deliberately says nothing
                // about what is or is not there.
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        } else {
            List {
                ForEach(projects) { project in
                    ProjectRow(
                        project: project,
                        progress: TreeOps.progressOf(tree, project.id),
                        onOpen: { onOpen(project.id) })
                        // Deleting a project takes everything under it, so this
                        // is not the same weight of action as deleting a task.
                        // `role: .destructive` alone would fire on a full swipe
                        // — the confirmation is what stops a project vanishing
                        // from a gesture aimed at the row below.
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                onDelete(project.id)
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                }
            }
            .listStyle(.plain)
        }
    }
}

/// One project: its name, how far along it is, and a bar.
private struct ProjectRow: View {
    let project: Node
    let progress: TreeOps.Progress
    let onOpen: () -> Void

    private var complete: Bool { progress.pct == 100 }

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    if project.pinned == true {
                        Image(systemName: "pin.fill")
                            .font(.caption2)
                            .foregroundStyle(.tint)
                    }
                    // Untitled is the web's word for a project with no name, and
                    // an empty row would otherwise look unopenable.
                    Text(project.text.isEmpty ? "Untitled" : project.text)
                        .font(.body.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Text(complete ? "All done" : "\(progress.done)/\(progress.total)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(
                            complete ? AnyShapeStyle(Color.green) : AnyShapeStyle(.secondary))
                }

                Capsule()
                    .fill(.quaternary)
                    .frame(height: 4)
                    .overlay(alignment: .leading) {
                        GeometryReader { geo in
                            Capsule()
                                .fill(complete ? Color.green : Color.accentColor)
                                .frame(width: geo.size.width * CGFloat(progress.pct) / 100)
                        }
                    }
            }
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// Row frames in global space, collected up the view tree.
///
/// The hit-test needs every row's box at once, but only each row knows its own.
/// A preference is the way SwiftUI passes that upward without the parent
/// measuring children it does not own.
private struct RowFramesKey: PreferenceKey {
    static var defaultValue: [NodeId: CGRect] { [:] }
    static func reduce(value: inout [NodeId: CGRect], nextValue: () -> [NodeId: CGRect]) {
        value.merge(nextValue()) { _, new in new }
    }
}
