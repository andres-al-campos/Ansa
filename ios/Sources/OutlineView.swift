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
    @State private var draft = ""
    @FocusState private var capturing: Bool
    /// The row being dragged, once a long press has armed it, plus where the
    /// finger is and where the row would land. All three are one gesture's
    /// worth of state, so they live and die together in `endDrag`.
    @State private var dragging: NodeId?
    @State private var dragPoint: CGPoint = .zero
    @State private var dropTarget: TreeOps.DropTarget?
    /// Row boxes in list space, keyed by id, refreshed as rows lay out.
    @State private var rowFrames: [NodeId: CGRect] = [:]
    /// The list's own origin, so a touch in global space can be rebased onto
    /// the rows without every row having to know where the list starts.
    @State private var listOrigin: CGPoint = .zero
    /// The project whose delete is awaiting confirmation.
    @State private var pendingDelete: Node?
    /// The row being renamed in place, and its live text. Held here rather than
    /// in the row so the tree can change underneath without resetting the field
    /// the user is typing into.
    @State private var editing: NodeId?
    @State private var editText = ""
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
    private let haptic = UIImpactFeedbackGenerator(style: .light)

    private var tree: Tree { store.tree }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Scrolls away with the list rather than pinning: it says where
                // you are and how far in, which is read on arrival rather than
                // watched continuously. Pinning both ends squeezed an already
                // short screen.
                // Only inside a project. On the grid each card carries its own
                // bar, and a single figure across every project at once answers
                // a question nobody asked.
                if scope != nil, let progress = TreeOps.scopeProgress(tree, scope) {
                    ScopeProgress(progress: progress)
                }

                if !store.live {
                    // Only about receiving. Saying "not saved" here would be a
                    // lie that pushes people into re-typing work that is
                    // already queued and will go out on its own.
                    SyncBanner(
                        text: "Not receiving changes from other devices. Your edits are still saved.")
                }

                if scope == nil {
                    ProjectGrid(tree: tree, onOpen: openProject, onDelete: confirmDeleteProject)
                } else {
                    outline
                }

                // Capture sits at the bottom. It was at the top so an idea
                // could be caught without scrolling anywhere first, which is
                // what this app is for — the bottom serves that just as well,
                // and adds two things the top could not: it is inside the
                // thumb's arc, and it rises with the keyboard instead of
                // sitting at the far end of the screen from it.
                captureField
            }
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
            .onChange(of: capturing || dragging != nil || editing != nil) { _, busy in
                store.setBusy(busy)
            }
            // A project takes its whole subtree with it, and unlike ticking a
            // parent that is not undoable — the ops are one-way. The web arms
            // the trash and confirms in place; a dialog is the same idea in the
            // platform's own idiom, and it can say how much is going.
            .confirmationDialog(
                pendingDelete.map { "Delete \($0.text.isEmpty ? "Untitled" : $0.text)?" } ?? "",
                isPresented: Binding(
                    get: { pendingDelete != nil },
                    set: { if !$0 { pendingDelete = nil } }),
                titleVisibility: .visible,
                presenting: pendingDelete
            ) { project in
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

    /// The rows themselves. Only drawn inside a project — the root shows the
    /// project grid instead.
    private var outline: some View {
        List {
            ForEach(rows, id: \.node.id) { row in
                OutlineRow(
                    node: row.node,
                    depth: row.depth,
                    hasChildren: !TreeOps.isLeaf(tree, row.node.id),
                    editing: editing == row.node.id,
                    editText: $editText,
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
                    onDragBegan: { beginDrag(row.node.id) },
                    onDragMoved: { p in dragMoved(p) },
                    onDragEnded: endDrag,
                    isDragging: dragging == row.node.id)
                    .background(
                        GeometryReader { geo in
                            Color.clear.preference(
                                key: RowFramesKey.self,
                                value: [row.node.id: geo.frame(in: .global)])
                        })
                    // Zoom lives on a swipe rather than on the bullet.
                    // It is one Back tap to undo but replaces the whole
                    // screen, and a revealed action cannot fire from a
                    // brush the way a button in the row can — it needs
                    // a second tap, or a deliberate push past the
                    // full-swipe threshold.
                    .swipeActions(edge: .trailing) {
                        Button {
                            scope = row.node.id
                        } label: {
                            Label("Zoom in", systemImage: "chevron.right")
                        }
                        .tint(.accentColor)
                    }
            }
            .onDelete(perform: delete)
        }
        .listStyle(.plain)
        .onPreferenceChange(RowFramesKey.self) { rowFrames = $0 }
        // The indicator is drawn in the list's space while every frame is
        // measured globally, so the overlay records its own origin to convert
        // between the two.
        .overlay(alignment: .topLeading) {
            GeometryReader { geo in
                ZStack(alignment: .topLeading) {
                    depthGuides
                    dropIndicator
                }
                    .onAppear { listOrigin = geo.frame(in: .global).origin }
                    .onChange(of: geo.frame(in: .global).origin) { _, o in listOrigin = o }
            }
        }

    }

    private var captureField: some View {
        HStack {
            TextField(scope == nil ? "New project" : "Add a task", text: $draft)
                .textFieldStyle(.plain)
                .submitLabel(.done)
                .focused($capturing)
                .onSubmit(commitDraft)
            if !draft.isEmpty {
                Button("Add", action: commitDraft)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private var title: String {
        scope.flatMap { TreeOps.byId(tree, $0)?.text } ?? "Ansa"
    }

    /// The rows the outline draws, flattened depth-first with a folded subtree
    /// counting as the single line it shows.
    private var rows: [(node: Node, depth: Int)] {
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

    /// Every edit goes through the store, which applies it locally and queues
    /// it for the server. Nothing here mutates the tree directly.
    private func apply(_ op: Op) {
        store.apply(op)
    }

    private func commitDraft() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        // The id and the timestamp are minted here and carried by the op, so the
        // server applies it to exactly the node this device created.
        apply(.addChild(
            id: TreeOps.newId(), parentId: scope, text: text,
            at: Date().timeIntervalSince1970 * 1000))
        draft = ""
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
    private var boxes: [TreeOps.RowBox] {
        rows.compactMap { row in
            guard let f = rowFrames[row.node.id] else { return nil }
            return .init(id: row.node.id, top: f.minY, height: f.height)
        }
    }

    /// The rows' shared left edge in global space.
    ///
    /// Any row's will do: the indent is padding *inside* the row, so every
    /// frame starts at the list's own inset whatever its depth. Taking the
    /// minimum avoids depending on which row happens to be first.
    private var rowsLeft: CGFloat { rowFrames.values.map(\.minX).min() ?? 0 }

    private func beginDrag(_ id: NodeId) {
        dragging = id
        dropTarget = nil
    }

    /// Re-run the hit-test for the finger's current position.
    ///
    /// Global coordinates throughout: the row frames are measured in global
    /// space and the gesture reports in it, so nothing has to know where the
    /// list begins. Only the X needs rebasing, onto the row's own left edge,
    /// because that is where the indent steps are counted from.
    private func dragMoved(_ point: CGPoint) {
        guard let dragging else { return }
        dragPoint = point
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
        if next != dropTarget { haptic.impactOccurred(intensity: 0.6) }
        dropTarget = next
    }

    /// Release: apply the drop, then clear every piece of drag state together.
    private func endDrag() {
        defer {
            dragging = nil
            dropTarget = nil
        }
        guard let dragging, let target = dropTarget,
              let op = TreeOps.dropOp(tree, dragging, target, scope: scope) else { return }
        apply(op)
    }

    /// The vertical lines connecting a parent to everything under it.
    ///
    /// Drawn here, over the list, rather than in each row's background. The
    /// earlier attempt put them behind the rows and `List`'s per-row insets cut
    /// every line into segments; one rect spanning the whole run cannot be cut
    /// that way. They also sit in the bullet column now, which does not move
    /// when text wraps — the two reasons guides failed the first time.
    ///
    /// A span whose rows are all scrolled out simply produces an empty frame,
    /// so nothing needs to know about the viewport.
    @ViewBuilder private var depthGuides: some View {
        // Rebased onto the rows' own left edge: the overlay starts at the
        // list's edge, and `List` spends its own inset before the row begins.
        let left = rowsLeft - listOrigin.x
        ForEach(TreeOps.guides(hitRows), id: \.parent) { guide in
            if let first = rowFrames[rows[guide.first].node.id],
               let last = rowFrames[rows[guide.last].node.id],
               let parent = rowFrames[guide.parent] {
                // From just below the parent's bullet to the bottom of the last
                // descendant. Starting at the parent's own centre would run the
                // line through the mark; starting at the row boundary would
                // leave a gap where the bullet's lower half is.
                let top = max(parent.midY + OutlineRow.markRadius, first.minY)
                Capsule()
                    .fill(Color.primary.opacity(0.12))
                    .frame(width: 1.5, height: max(0, last.maxY - top - 6))
                    .offset(
                        x: left + OutlineRow.guideX0
                            + CGFloat(guide.depth) * OutlineRow.indent - 0.75,
                        y: top - listOrigin.y)
            }
        }
    }

    /// The line showing where the row would land, drawn over the list.
    ///
    /// A gap shows a line indented to the depth the finger picked — that indent
    /// is the only thing distinguishing "sibling" from "child" at the same
    /// gap. Nesting into a row highlights the row instead, because there is no
    /// gap to draw in.
    @ViewBuilder private var dropIndicator: some View {
        if let target = dropTarget, let frame = rowFrames[target.id] {
            let left = rowsLeft
            switch target.mode {
            case .into:
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(Color.accentColor, lineWidth: 2)
                    .frame(width: frame.width, height: frame.height)
                    .offset(x: frame.minX - left, y: frame.minY - listOrigin.y)
            case .before, .after:
                let x = OutlineRow.guideX0 + CGFloat(target.depth ?? 0) * OutlineRow.indent
                Capsule()
                    .fill(Color.accentColor)
                    .frame(width: max(0, frame.width - x), height: 3)
                    .offset(
                        x: x,
                        y: (target.mode == .before ? frame.minY : frame.maxY) - listOrigin.y)
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
        editText = node.text
        editing = node.id
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
        guard let id = editing else { return }
        if let from, from != id { return }
        let op = TreeOps.commitEdit(tree, id, editText)
        if let op { apply(op) }

        editing = nil
        editText = ""
        focusedRow = nil
    }

    private func confirmDeleteProject(_ id: NodeId) {
        pendingDelete = TreeOps.byId(tree, id)
    }

    private func zoomOut() {
        scope = scope.flatMap { TreeOps.byId(tree, $0)?.parentId }
    }
}

/// One bar for the whole scope, the way the web app does it.
///
/// Blue while there is work left, green at 100% — the colour change is the
/// point, since a full bar and a nearly-full one are hard to tell apart at 4pt
/// tall.
private struct ScopeProgress: View {
    let progress: TreeOps.Progress

    private var complete: Bool { progress.pct == 100 }

    var body: some View {
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

            Text("\(progress.pct)%")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(complete ? AnyShapeStyle(Color.green) : AnyShapeStyle(.secondary))
                // Fixed width so the bar does not resize as the number goes
                // from one digit to three.
                .frame(width: 34, alignment: .trailing)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .animation(.easeOut(duration: 0.35), value: progress.pct)
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
        .padding(.horizontal)
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

    /// Long-press to arm, then drag. Without the press a drag off the bullet
    /// would fight the List's own scroll, and the bullet's fold tap would be
    /// impossible to land — a fold is a tap, and every tap starts as a tiny
    /// drag. The delay is what separates the two, so it is load-bearing rather
    /// than polish.
    private var dragGesture: some Gesture {
        LongPressGesture(minimumDuration: 0.35)
            .sequenced(before: DragGesture(coordinateSpace: .global))
            .onChanged { value in
                switch value {
                case .first:
                    break
                case .second(_, let drag):
                    guard let drag else {
                        onDragBegan()
                        return
                    }
                    onDragMoved(drag.location)
                }
            }
            .onEnded { _ in onDragEnded() }
    }

    /// One indent step, and the spacing between two depth guides.
    ///
    /// Wider than it needs to be for the tint alone. The guides are what set
    /// it: at 12pt four levels read as a hatch rather than four rails, and the
    /// guide is the only thing on screen that says which depth a drag landed
    /// on. The cost is label width at every level — depth 4 starts 164pt into
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
    static let guideX0: CGFloat = 16

    /// Half the bullet ring, so a guide can start clear of the mark it hangs
    /// from rather than through it.
    static let markRadius: CGFloat = 9

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
            Button(action: onCollapse) {
                Bullet(hasChildren: hasChildren, collapsed: node.collapsed)
                    // The dot is 6pt; a tap target has to be a finger wide
                    // regardless, so the frame is padded out rather than the
                    // mark drawn larger.
                    .frame(width: 32, height: 40)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // Only a parent can fold, but every row can be dragged, so the
            // disable covers the Button alone and the drag gesture is attached
            // outside it.
            .disabled(!hasChildren)
            // High priority, not `.gesture`: a plain gesture loses the touch to
            // the List's own scroll, so a real finger on the bullet scrolls the
            // page and the drag never arms. (Injected touches in a simulator
            // skip that arbitration, which is why this looked like it worked.)
            // The long-press delay is what keeps this from stealing the fold
            // tap — the press has to complete before the drag sees anything.
            .highPriorityGesture(dragGesture)

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
        .padding(.leading, CGFloat(depth) * Self.indent)
        .listRowBackground(tint)
        // No `.contentShape(Rectangle())` here. It makes the whole row a single
        // hit-test target, which swallows taps before they reach the checkbox
        // and the bullet — separate targets are the point of the row. Add it
        // only alongside a row-level tap action, never on its own.
    }

    /// Depth as a surface, not as a line.
    ///
    /// Guides came first, matching the web. They failed here for a reason the
    /// web does not have: rows wrap to two and three lines on a phone, so the
    /// text's left edge moves more from wrapping than from nesting, and any cue
    /// living in the gap beside the text is fighting that. `List` insets also
    /// broke each ancestor line into per-row segments, which read as noise.
    ///
    /// A tint marks the row itself, so wrapping cannot break it. It stops being
    /// separable past three levels — at which point the boundary between two
    /// adjacent rows still says which is deeper, which is why this degrades
    /// rather than failing. Deep trees are zoom's problem, not this one's.
    private var tint: Color {
        switch depth {
        case 0: .clear
        case 1: Color.primary.opacity(0.05)
        case 2: Color.primary.opacity(0.033)
        default: Color.primary.opacity(0.018)
        }
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
    let onOpen: (NodeId) -> Void
    let onDelete: (NodeId) -> Void

    private var projects: [Node] { TreeOps.projectList(tree) }

    var body: some View {
        if projects.isEmpty {
            ContentUnavailableView(
                "No projects yet",
                systemImage: "tray",
                description: Text("Start one below."))
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
