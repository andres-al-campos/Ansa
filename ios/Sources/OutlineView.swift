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
    /// Where the back gesture came from, most recent last.
    ///
    /// The tree parent is the wrong answer on its own: jump from a task deep in
    /// one project straight into another and "out" means the second project's
    /// parent, which is nowhere you have been. This records the trail instead,
    /// and `parentScope` falls back to the tree when it is empty — a resumed
    /// session has no trail but still has somewhere sensible to go.
    @State private var backTrail: [BackStep] = []
    /// Where the list should be put once a zoom out has landed, consumed by the
    /// slab that appears. Both the preview behind a back swipe and the screen
    /// it becomes read this, so the two agree and the landing does not jump.
    @State private var restore: ScrollAnchor?

    /// True until the user navigates themselves.
    ///
    /// The tree arrives after the view does, so the scope to resume into is not
    /// knowable at launch — it is adopted when the first real tree lands. This
    /// is what stops that adoption from yanking you out of a project you had
    /// already opened by hand in the meantime.
    @State private var autoScope = true
    /// Renaming and capture, grouped: the capture field files next to the row
    /// last edited, which only the edit path knows.
    @State private var edit = EditController()
    /// One drag's worth of state and the geometry it reads. Grouped into a type
    /// because these pieces are meaningless apart and always changed together.
    @State private var drag = ReorderDrag()
    /// The completion ripple — the wave of wiggles down a branch that just
    /// finished. See `RippleController`.
    @State private var ripple = RippleController()
    /// The project whose delete is awaiting confirmation.
    @State private var pendingDelete: Node?

    /// The scope being renamed, and the name being typed for it.
    ///
    /// Deliberately not `EditController`: that one is the row path's, keyed by
    /// the row whose `TextField` exists. The scope has no row — zooming in is
    /// what turns its row into the header — so its rename is a state of its
    /// own, and the two cannot overwrite each other.
    /// The trash row was tapped. There is no trash screen on the phone yet, so
    /// this says so rather than letting the row do nothing — a row that
    /// swallows a tap reads as broken.
    /// Whether the trash sheet is up.
    /// Whether the trash is the screen showing. A second axis beside `scope`
    /// rather than a case of it: every navigation helper here keys off a
    /// `NodeId?`, and the trash has no node to be. Only ever true at the grid,
    /// so back from it means home and nothing else.
    @State private var inTrash = false

    @State private var renamingScope: NodeId?
    @State private var renameText = ""
    @FocusState private var renamingFocus: Bool
    /// The outline's scroll proxy, kept so paths outside the `ScrollViewReader`
    /// can drive it.
    ///
    /// Adding a task is one: the row is created by a button living in the
    /// safe-area inset, well outside the reader's closure, and it has to be
    /// scrolled clear of the keyboard the moment it appears. Threading a proxy
    /// down through the button and every caller to reach one view is worse than
    /// holding the one the list already made.
    @State private var scroller: ScrollViewProxy?


    /// How far the edge swipe has pulled the view, in points.
    ///
    /// The gesture had no on-screen answer while it was deciding: the view sat
    /// still and then the scope changed, so a swipe that fell short looked the
    /// same as one that was never recognised. Tracking the finger makes the
    /// distance itself the feedback — the view comes back if you let go early,
    /// which is how the gesture teaches its own threshold.
    @State private var backPull: CGFloat = 0

    /// Whether a back swipe currently has the touch.
    ///
    /// Separate from `backPull`, which is how far the screen has moved: this is
    /// true from the first point of the gesture, while the pull stays at 0 until
    /// the finger has proved it is going sideways. The row's leading swipe
    /// reveals inside that gap, so `backPull` was too late to shut it out.
    ///
    /// Cleared when the finger lifts, so a back swipe that is abandoned gives
    /// the row swipe straight back.
    @State private var backHolding = false

    /// Whether a row's delete swipe currently has the touch.
    ///
    /// The mirror of `backHolding`, and needed for the same reason. That flag
    /// shuts the row out while the screen is being pulled; without this one the
    /// exclusion only ran one way, so a finger already dragging a row leftward
    /// could cross into the back swipe's strip and start sliding the whole
    /// screen mid-delete — one touch driving two gestures.
    ///
    /// Set by the row rather than derived from its offset, because the claim
    /// has to land on the first callback: `claims` asks where the touch began,
    /// and a flag that waited for visible travel would answer too late.
    @State private var rowSwiping = false


    /// The sliding view's own width, which the back threshold is a fraction of.
    ///
    /// Measured rather than read off the screen: this is the width of the thing
    /// that actually moves, so it stays right on an iPad split or a rotation
    /// where a device-wide constant would not be. Seeded at a phone's width so
    /// the very first callback of a swipe has something sane to divide by.
    @State private var slabWidth: CGFloat = 393

    /// Which row's field holds focus, by node id rather than a bare Bool.
    ///
    /// A single shared `Bool` across the ForEach cannot express "focus the row
    /// that is replacing this one" — the write is ambiguous between the field
    /// being torn down and the one being built, and Return-for-new-sibling
    /// lost it every time. Naming the id makes the target unambiguous.
    @FocusState private var focusedRow: NodeId?
    /// The empty row waiting below the one being typed in, during a run.
    ///
    /// Return has to land on a field that already exists — building one and
    /// focusing it leaves a moment with nothing focused, and iOS takes the
    /// keyboard down for exactly that moment. Keeping a row one step ahead
    /// means the handover is a focus move between two live fields.
    ///
    /// Nil outside a run, and cleared by `dropSpare` on every exit, because an
    /// empty row that outlives the run is a blank task.
    @State private var spareRow: NodeId?
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
                // `inTrash` is read by `slab` itself, so the copy behind a
                // trash pull has to be drawn with it already false — otherwise
                // the screen revealed is a second trash.
                slab(for: inTrash ? nil : peekBack.scope,
                     interactive: false, trash: false,
                     restoring: inTrash ? nil : peekBack.at)
                // Over the revealed screen, under the one being lifted off it.
                backdrop
            }
            slab(for: scope, interactive: true, trash: inTrash, restoring: restore)
            .background {
                GeometryReader { geo in
                    Color.clear
                        .onAppear { slabWidth = geo.size.width }
                        .onChange(of: geo.size.width) { _, w in slabWidth = w }
                }
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
                case .background:
                    // The waiting row is a real empty node. Suspending with one
                    // staged would sync it as a blank task and show it on the
                    // web, so the run ends when the app leaves the foreground.
                    if edit.adding { stopAdding() }
                    store.suspend()
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
                // Land where you left off. `lastOpenedAt` lives in the tree, so
                // the answer follows the account rather than this device —
                // close the app at the desk, open it on the phone, same
                // project. Only while the user has not navigated already, and
                // only from an empty scope, so it never moves the view out from
                // under someone who is looking at something.
                //
                // On `tree` rather than at launch because the tree is not there
                // yet when the view is built. Project-level by design, not the
                // exact sub-scope — see `resumeScope` in `shared/tree.ts`.
                if autoScope, scope == nil, !now.isEmpty {
                    scope = TreeOps.resumeScope(now)
                }
            }
            // The cached tree is already loaded when the store is built, so it
            // never arrives as a *change* and `onChange` above never sees it.
            // This is the one that fires on a cold open; the other one is for
            // the server's tree landing afterwards and correcting the guess.
            .onAppear {
                if autoScope, scope == nil, !tree.isEmpty {
                    scope = TreeOps.resumeScope(tree)
                }
            }
            // Two mid-edit states, and the store takes one flag, so they are
            // combined here rather than each calling setBusy on its own — the
            // one that ends first would otherwise clear the other's hold.
            //
            // Typing: a row holds text the user can see, and adopting a
            // server tree under it is what makes it vanish as it is being
            // written. Dragging: the row would move out from under the finger
            // mid-gesture.
            //
            // One flag covers adding too, because a new task is a row with a
            // field open like any other.
            .onChange(of: drag.isActive || edit.isEditing) { _, busy in
                store.setBusy(busy)
            }
            // An alert rather than a confirmation dialog: the latter slides up
            // as an action sheet, which reads as a menu of things you might do
            // next rather than a question. Deleting a project takes every task
            // under it, so it wants the centred, modal version with an explicit
            // labelled cancel.
            .alert(
                pendingDelete.map { "Delete \($0.text.isEmpty ? "Untitled" : $0.text)?" } ?? "",
                isPresented: Binding(
                    get: { pendingDelete != nil },
                    set: { if !$0 { pendingDelete = nil } }),
                presenting: pendingDelete
            ) { target in
                Button("Cancel", role: .cancel) { pendingDelete = nil }
                // "Delete" plainly: this now guards a task in the outline as
                // well as a project on the grid, and the alert's own title
                // already names which one.
                Button("Delete", role: .destructive) {
                    // Out first when it is the screen you are standing on —
                    // to the parent, not through `zoomOut`, which walks the
                    // back trail and would land you on whatever scope you
                    // happened to visit before. The place to be after
                    // deleting something is where it used to be listed.
                    if scope == target.id { setScope(target.parentId) }
                    apply(.removeNode(id: target.id, trash: true))
                    pendingDelete = nil
                }
            } message: { project in
                let count = TreeOps.subtreeOf(tree, project.id).count
                // No longer "this cannot be undone" — it goes to the trash and
                // can be restored for 30 days. Saying otherwise would be the
                // scarier claim of the two, and the wrong one.
                Text(count == 0
                    ? "It stays in the trash for 30 days."
                    : "This deletes \(count) task\(count == 1 ? "" : "s") under it. They stay in the trash for 30 days.")
            }
            // Swipe right from the left edge to zoom out. Zooming changes
            // `scope` in place rather than pushing, so there is no stack entry
            // for `NavigationStack` to pop and the gesture has to be built.
            //
            // Edge-only: the rows carry their own swipe, and a full-width
            // recogniser would race it.
            // The ground names where the swipe is going rather than being a
            // bare colour: two near-identical dark surfaces with nothing on the
            // lower one read as the app failing to draw, not as depth.
            }
            // Simultaneous, not exclusive. Attached plainly this broke the row
            // drag on a real phone: an ancestor `DragGesture` recognises at 20pt
            // and takes the touch sequence, and `armed` runs inside the handler,
            // far too late to give it back. Simultaneous recognition lets both
            // see the same touch; `armed` then settles which one acts.
            //
            // None of this reproduces on the simulator, where a synthesised
            // touch path never makes the recognisers contend.
            .simultaneousGesture(zoomOutSwipe)
            // No `.toolbar`. The bar belongs to the `NavigationStack` and
            // renders outside this view, so `backPull`'s offset moved the whole
            // screen except its header. The header is drawn inside the slab.
            .navigationBarHidden(true)
        }
    }

    /// Finish renaming the scope.
    ///
    /// Through `TreeOps.commitEdit`, the same rule a row uses: an emptied name
    /// deletes the node, an unchanged one is no op. Renaming the scope should
    /// not mean something different from renaming a row.
    private func commitScopeRename() {
        guard let id = renamingScope else { return }
        renamingScope = nil
        let op = TreeOps.commitEdit(tree, id, renameText)
        // Leave before it goes. Emptying the name deletes the node, and that
        // node is the screen you are standing on — the header would go on
        // naming something the tree no longer has. To the parent, where it
        // used to be listed, not through `zoomOut` and its back trail.
        if case .removeNode = op { setScope(TreeOps.byId(tree, id)?.parentId) }
        if let op { apply(op) }
    }

    /// Rename, pin and delete, aimed at the scope itself.
    ///
    /// Ellipsis rather than a named glyph: the three actions have nothing in
    /// common to name, and iOS spells "more, on this thing" this way
    /// everywhere else.
    @ViewBuilder private var scopeMenu: some View {
        if let id = scope, let node = TreeOps.byId(tree, id) {
            Menu {
                Button("Rename", systemImage: "pencil") {
                    renameText = node.text
                    renamingScope = id
                }

                // The web calls a pinned project a place you go and a pinned
                // task a thing to do; both are pins, so this is offered at any
                // depth. The home screen's Pinned shelf shows both back, the
                // same as the web's sidebar.
                //
                // The web's pin rather than the system's: a pin standing up to
                // pin, lying over to unpin. `pin.slash` said the same thing
                // with a slash, and a slash negates a state rather than an
                // action — see `PinIcon`.
                Button {
                    apply(.setPinned(id: id, pinned: node.pinned != true))
                } label: {
                    Label {
                        Text(node.pinned == true ? "Unpin" : "Pin")
                    } icon: {
                        Image(uiImage: PinIcon.image(over: node.pinned == true))
                    }
                }

                // No divider. Red says which one this is, and the alert is
                // what actually guards it.
                Button("Delete", systemImage: "trash", role: .destructive) {
                    pendingDelete = node
                }
            } label: {
                // Bare glyph at the bar's own size, so it weighs the same as
                // the chevron opposite. The circle drew a button around one of
                // the two and not the other.
                Image(systemName: "ellipsis")
            }
        }
    }

    /// The title band, drawn inside the slab rather than as a `.toolbar`.
    ///
    /// It has to live here for the back swipe to work: the offset that slides a
    /// screen aside is on the slab, and a `NavigationStack` toolbar is rendered
    /// outside it — so a system bar stayed pinned while the page moved under
    /// it. Drawn here it slides with the page, and the copy behind the swipe
    /// gets its own header revealed underneath, which is what the gesture is
    /// supposed to show.
    ///
    /// Parameterised on scope and trash for the same reason `slab` is: the two
    /// copies on screen during a swipe are different screens and must not share
    /// a title.
    @ViewBuilder private func header(for scope: NodeId?, interactive: Bool, trash: Bool)
        -> some View
    {
        if trash || scope != nil {
            HStack(spacing: Space.row) {
                // Inert on the copy behind the swipe, like everything else
                // there — it is a screen you may still slide away from.
                Button("Back", systemImage: "chevron.left") {
                    if interactive { zoomOut() }
                }
                .labelStyle(.iconOnly)

                Spacer(minLength: 0)

                // The destination, not the route. The strip below used to name
                // the scope and the crumbs above used to name the way in; the
                // name was on screen twice and the two bands cost ~104pt
                // between them. This is one band.
                //
                // The trail is still here, folded into the title: tapping the
                // name opens the path as a menu. What is gone is the horizontal
                // path, which spent width to answer a question asked far less
                // often than "how far in am I".
                if trash {
                    // A plain name. `ScopeTitle` carries a progress ring and
                    // opens the lineage as a menu, and the trash has neither.
                    Text("Trash").font(.headline)
                } else {
                    ScopeTitle(
                        title: title(of: scope),
                        // Only the live copy can be a drop target; a drag and a
                        // back swipe cannot both be running.
                        lit: interactive && litRoot,
                        path: scope.map { TreeOps.lineageOf(tree, $0) } ?? [],
                        onTap: { if interactive { setScope($0) } },
                        editing: interactive && renamingScope != nil && renamingScope == scope,
                        editText: $renameText,
                        typing: $renamingFocus,
                        onCommit: commitScopeRename)
                }

                Spacer(minLength: 0)

                // Balances the chevron opposite whether or not there is a menu
                // to show, so the title stays centred on the trash screen too.
                if trash {
                    Image(systemName: "ellipsis").opacity(0)
                } else {
                    scopeMenu.disabled(!interactive)
                }
            }
            .padding(.horizontal, Space.gutter)
            // No fixed height. The buttons already carry the 44pt hit target
            // the system bar was sized around, so the band lands in the same
            // place without a number that a larger Dynamic Type setting would
            // then be squeezed into.
            .frame(minHeight: 44)
            // The material the bar had, not a flat fill. Rows scrolling up
            // under the header blur through it instead of vanishing at a hard
            // edge, which is the one thing that gave away that this is a view
            // in the page rather than the bar it replaced.
            .background(.bar)
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
    @ViewBuilder private func slab(
        for scope: NodeId?, interactive: Bool, trash: Bool,
        restoring: ScrollAnchor? = nil
    ) -> some View {
            VStack(spacing: 0) {
                header(for: scope, interactive: interactive, trash: trash)

                if !store.live {
                    // Only about receiving. Saying "not saved" here would be a
                    // lie that pushes people into re-typing work that is
                    // already queued and will go out on its own.
                    SyncBanner(
                        text:
                            "Not receiving changes from other devices. Your edits are still saved."
                    )
                }

                if trash {
                    // `interactive` too: the copy drawn behind the swipe must
                    // not take the gesture either, the same as an outline's.
                    TrashView(store: store, backing: interactive && backPull > 0)
                } else if scope == nil {
                    ProjectGrid(
                        tree: tree, loaded: store.loaded,
                        editing: edit.editing, editText: $edit.text,
                        focused: $focusedRow,
                        onOpen: openProject,
                        onBeginEdit: beginEdit,
                        // Return on a project name means "done naming", not
                        // "next project" — a run of projects is not a thing
                        // people do, so this is a plain commit either way.
                        onSubmit: submitProjectName,
                        onDelete: confirmDeleteProject,
                        onMoveProject: moveProject,
                        onMovePin: movePin,
                        onOpenTrash: { openTrash() })
                } else {
                    // Under the bar, above the list: the figure the title used
                    // to carry as a caption. Only here — the grid and the trash
                    // have no scope to be a fraction of.
                    ScopeProgress(progress: adjusted(TreeOps.scopeProgress(tree, scope)))
                    outline(for: scope, interactive: interactive,
                            restoring: restoring)
                }

            }
        // Over the list rather than below it, so it costs no height — and as a
        // safe-area inset rather than an overlay, because the inset is what
        // rises with the keyboard. Sitting still while the keyboard came up
        // would put the button under it at exactly the moment it becomes the
        // way out.
        //
        // On the grid too, where it makes a project rather than a task. Gating
        // it to inside a project left the empty state telling people to start
        // one below a field that no longer exists, with no way to make a first
        // project at all.
        .safeAreaInset(edge: .bottom, alignment: .trailing, spacing: 0) {
            // Not in the trash. Everything here makes something — a task, or a
            // project from the grid — and the trash is the one screen where
            // there is nothing to add to.
            if !trash {
                captureButton(interactive: interactive)
            }
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
    private func outline(
        for scope: NodeId?, interactive: Bool, restoring: ScrollAnchor?
    ) -> some View {
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
                    onToggleDone: { toggleDone(row.node) },
                    onCollapse: { toggleFold(row.node.id, proxy: proxy) },
                    rippleDelay: interactive ? ripple.delay(for: row.node.id) : nil,
                    groupDone: groupDone(row.node),
                    adding: edit.adding,
                    onBeginEdit: { beginEdit(row.node) },
                    onBlur: { id in commitEdit(from: id, releasingFocus: false) },
                    // Return means one thing per mode. Renaming, it commits and
                    // stops — a rename is finished when the words are right, and
                    // there is nothing to advance to. Adding, it commits and
                    // opens the next row, which is the whole shape of a run.
                    onSubmit: { edit.adding ? submitAdding() : commitEdit() },
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
                    isDragging: interactive && drag.dragging == row.node.id,
                    // The same row `parentHighlight` outlines — the bullet is
                    // the thing being dropped into, so it lights with the row
                    // rather than leaving the highlight to the frame alone.
                    isDropTarget: interactive && litGuideParent == row.node.id,
                    onDelete: { if interactive { delete(row.node.id) } },
                    onZoom: { if interactive { setScope(row.node.id) } },
                    backHolding: backHolding,
                    onSwipingChanged: { if interactive { rowSwiping = $0 } },
                    guides: AnyView(
                        guideSegments(for: row.node.id, in: rows(of: scope))),
                    screenWidth: slabWidth)
                    // The waiting row stays in the hierarchy but takes up no
                    // space and draws nothing. It has to stay built: it exists
                    // so Return has a live field to move focus onto, and
                    // filtering it out of `rows(of:)` would destroy that field
                    // and reopen the gap that drops the keyboard. But it is an
                    // empty row, so drawing it puts a blank line under the
                    // cursor for the whole run — the implementation detail
                    // showing through as what looks like a stray empty task.
                    //
                    // `frame(height: 0)` over `hidden()` alone because hidden
                    // still reserves the row's height.
                    .opacity(row.node.id == spareRow ? 0 : 1)
                    .frame(height: row.node.id == spareRow ? 0 : nil)
                    .allowsHitTesting(row.node.id != spareRow)
                    // The row owns its vertical spacing, and `List`'s own
                    // row insets are zeroed below, so the row frame *is* the
                    // cell. That is what lets each row's guide segment simply
                    // fill its row and still meet its neighbours, abutting
                    // into what reads as one unbroken line.
                    //
                    // Compensating for the insets instead was the earlier
                    // approach and was wrong: it needed the inset height as a
                    // measured constant, right only on the device it was
                    // measured on.
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
                    // Neither edge is `swipeActions`. Both are `OutlineRow`'s
                    // own gesture: the commit threshold has to be a fixed
                    // fraction of the screen and UIKit does not expose its own,
                    // so the two edges committed at visibly different
                    // distances.
                    //
                    // The back swipe is handled inside that gesture too: it
                    // travels the same way as a zoom, so the row declines the
                    // touch while `backHolding` is set rather than racing it.
            }
            // No `.onDelete`. It looks like the harmless way to spell "rows can
            // be deleted", but SwiftUI turns it into a full-swipe gesture of
            // its own — haptic and all — on the same edge the row's swipe
            // uses. That is UIKit's threshold, three quarters of the way
            // across, and it ran no matter what this row did with the edge: it
            // is what a delete actually fired, and it is why the button the
            // trailing `swipeActions` used to reveal could never be tapped.
            // Nothing else reaches it, since this list has no edit mode.
        }
        .listStyle(.plain)
        // The directional lock the platform does not hand you. Every gesture
        // here is recognised simultaneously, so none of them takes the touch
        // away from the list — without this a swipe carrying any vertical drift
        // slid the screen and scrolled the rows at once.
        //
        // Also while a row is in the air: the drag reads the frames it
        // measured, so a list scrolling under it moves the answer out from
        // under the finger. Edge-scrolling is the controller's own tick.
        //
        // `rowSwiping` is set once the pull clears 20pt, the point the gesture
        // has proved it is horizontal — before that a drifting scroll must
        // still be able to scroll.
        .scrollDisabled(interactive && (backPull > 0 || drag.isActive || rowSwiping))
        // Put the list back where it was when this scope was last left.
        //
        // Unanimated, so the position is already right on the first frame
        // rather than seen to travel. The preview behind a back swipe reads the
        // same anchor, so what slides in and what lands are the same picture.
        //
        // `.onChange` and not `.onAppear`: zooming out swaps this slab's rows
        // without rebuilding the slab, so its `onAppear` fires once at launch
        // and never again.
        .onChange(of: restoring) { _, anchor in
            guard let anchor else { return }
            applyAnchor(anchor, with: proxy, live: interactive)
        }
        .onAppear {
            guard let restoring else { return }
            applyAnchor(restoring, with: proxy, live: interactive)
        }
        // The carry, for every row at once.
        //
        // One recogniser on the list rather than one per row. Per-row was what
        // starved scrolling: every row a finger touched added a `DragGesture`
        // contending for the same touch, and `List`'s pan lost to the crowd
        // even when each one was inert. There is only ever one row in the air,
        // so one recogniser is all the drag ever needed.
        //
        // Inert until a row's press has armed it, so an ordinary scroll passes
        // through untouched.
        .simultaneousGesture(carryGesture, isEnabled: interactive)
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
        // Only the live copy's proxy. The one behind a swipe scrolls a list
        // that is on its way off screen.
        .onAppear { if interactive { scroller = proxy } }
        }
    }

    /// The one control: plus at rest, checkmark while adding. The same button
    /// is also the way out, and the symbol swap is what says the mode is on.
    ///
    /// Inert behind a swipe for the same reason as a row's field — the copy
    /// underneath must not act on a screen that is sliding away.
    @ViewBuilder private func captureButton(interactive: Bool) -> some View {
        let adding = edit.adding
        Button {
            if adding { stopAdding() } else { startAdding() }
        } label: {
            // A tick is safe here only because Return is an arrow. When
            // both showed a tick they meant opposite things a thumb's width
            // apart, which is how a run ends by accident; with "next" drawn
            // as an arrow the tick is unambiguously "no more rows".
            //
            // Quiet in both states, matching the back and home buttons. Neither
            // glyph is doing repeated work — Return is, while adding — and a
            // filled accent circle on a corner control that gets pressed twice
            // per run was the loudest thing on a screen that is mostly text.
            Image(systemName: adding ? "checkmark" : "plus")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(Color.primary)
                // Flattened before the material, not after. `drawingGroup`
                // rasterises into its own buffer, and a material inside one has
                // no backdrop left to sample — so it stopped being glass and
                // resolved to a flat dark disc, black against light mode.
                //
                // The flatten's original job: the button rides the bottom
                // safe-area inset, which animates down with the keyboard, and
                // the circle travelled with it while the `Image` was laid out
                // against the *final* safe area from the first frame — two
                // images in two coordinate spaces inside one view.
                .drawingGroup()
                .frame(width: 52, height: 52)
                .modifier(CaptureButtonSurface())
                // Deliberately no `.id(adding)` and no transition. Either one
                // makes the two states separate views, so SwiftUI removes one
                // and inserts the other, which is a second way to get two
                // buttons on screen at once.
        }
        .buttonStyle(.plain)
        .disabled(!interactive)
        // 36 from both edges, stated once. This rides a `safeAreaInset`, so
        // the bottom padding stacks on whatever the system reserves for the
        // home indicator: the same number on both sides sat it ~50 from the
        // bottom and 16 from the right. Subtracting the strip on one side and
        // adding it on the other is what makes the two distances equal on a
        // phone that has one and on a phone that does not.
        //
        // Clamped at 0 because 36 is less than the ~34pt strip by only 2 — a
        // deeper inset on some future device would otherwise push the button
        // down into the swipe-up area rather than stopping at its edge.
        .padding(.bottom, max(0, Space.corner - homeIndicator))
        .padding(.trailing, Space.corner)
        .accessibilityLabel(adding ? "Done adding" : "Add a task")
    }


    /// The strip the system reserves at the bottom for the home indicator, or 0
    /// on a phone with a physical button. What the capture button's trailing
    /// padding has to match to sit the same distance from both edges.
    private var homeIndicator: CGFloat {
        UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow?.safeAreaInsets.bottom }
            .first ?? 0
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

    /// Whether there is a screen behind this one. The grid is the floor, and
    /// the trash sits one step above it however deep the scope underneath was.
    private var canGoBack: Bool { inTrash || scope != nil }

    /// Take the waiting row back out of the count.
    ///
    /// It is a real leaf in the tree, so `scopeProgress` counts it, and a run
    /// would read "0 of 4" with three tasks on screen. Corrected here rather
    /// than in `TreeOps` because the spare is a detail of how this view keeps
    /// the keyboard up — the model has no reason to know about it.
    ///
    /// Returning nil when the spare was the only leaf is fine: `ScopeTitle`
    /// draws nil as 0%, so the header keeps its height either way.
    private func adjusted(_ progress: TreeOps.Progress?) -> TreeOps.Progress? {
        guard let progress, spareRow != nil else { return progress }
        let total = progress.total - 1
        guard total > 0 else { return nil }
        let pct = Int((Double(progress.done) / Double(total) * 100).rounded())
        return TreeOps.Progress(done: progress.done, total: total, pct: pct)
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

    /// A project dragged to a new position in the home list.
    ///
    /// `from` and `to` index the *unpinned* projects, which is what that list
    /// draws, while `moveNode` counts positions among every root. Pinned
    /// projects sit in the shelf above and still hold root positions, so the
    /// two only agree when nothing is pinned — hence the translation through
    /// the neighbour's own index rather than passing `to` straight through.
    private func moveProject(from: IndexSet, to: Int) {
        let unpinned = TreeOps.projectSections(tree).unpinned
        guard let src = from.first, src < unpinned.count else { return }
        let roots = TreeOps.roots(tree)

        // The row it lands above, in the list the drag was reading. Past the
        // end there is none, and the move goes to the end of the roots.
        let movedId = unpinned[src].id
        let landsAbove = to < unpinned.count ? unpinned[to].id : nil
        let destination =
            landsAbove.flatMap { id in roots.firstIndex { $0.id == id } } ?? roots.count
        guard let current = roots.firstIndex(where: { $0.id == movedId }),
              destination != current
        else { return }

        apply(.moveNode(id: movedId, parentId: nil, index: destination))
    }

    /// A pin dragged to a new position on the shelf.
    ///
    /// One drag is several ops — the shelf renumbers densely — and `AnsaCore`
    /// derives them, so the rule that decides the order lives beside the sort
    /// that reads it.
    private func movePin(from: IndexSet, to: Int) {
        guard let src = from.first else { return }
        // `onMove` reports a destination *before* the row is lifted out, so a
        // downward drag is one past where it lands. `reorderPinsOps` takes an
        // index into the list without the moved row, which is the other
        // convention.
        let dest = to > src ? to - 1 : to
        for op in TreeOps.reorderPinsOps(tree, from: src, to: dest) { apply(op) }
    }

    /// Whether this row's box should read as "the whole group is finished".
    ///
    /// True when the row is done and its parent is too — a root counts, having
    /// no group above it to be unfinished. So the green spreads up a branch only
    /// as far as the completion actually reaches, and a done task sitting under
    /// an unfinished parent stays blue.
    ///
    /// Ported from `groupDone` in `src/Outliner.tsx`.
    private func groupDone(_ node: Node) -> Bool {
        guard node.done else { return false }
        guard let parentId = node.parentId else { return true }
        return TreeOps.byId(store.tree, parentId)?.done ?? true
    }

    /// Tick a task, and ripple if that finished a branch.
    ///
    /// The ripple is the reward for *finishing* something, so it fires only when
    /// a group closes out — not on every individual tick. A lone leaf that does
    /// not complete its parent stays quiet; the payoff is saved for the moment a
    /// branch actually finishes. Two ways a tap finishes one: it ticks a parent,
    /// completing that whole subtree at once, or it is the last leaf that flips
    /// an ancestor to done. `completed` lists only the ancestors that flipped,
    /// never the tapped node, so the tap is checked for children too.
    ///
    /// Un-ticking never ripples. Ported from `handleToggleDone` in
    /// `src/Outliner.tsx`.
    private func toggleDone(_ node: Node) {
        let willComplete = !node.done
        let tappedIsParent = !TreeOps.isLeaf(store.tree, node.id)
        let completed = store.apply(.setDone(id: node.id, done: willComplete))
        guard willComplete, !completed.isEmpty || tappedIsParent else { return }

        // The highest ancestor that flipped, else the tapped parent itself.
        let topId = completed.last ?? node.id
        var inSubtree = Set(TreeOps.subtreeOf(store.tree, topId).map(\.id))
        inSubtree.insert(topId)
        // In visible order, and only the rows on screen — a collapsed
        // descendant has nothing to wiggle.
        ripple.start(rows.filter { inSubtree.contains($0.node.id) }.map(\.node.id))
    }

    /// Fold or unfold a row, with the rows below moving rather than jumping.
    ///
    /// Animated here rather than inside `apply`, which every op goes through:
    /// a sync landing from another device would otherwise animate rows the user
    /// never touched, turning a background update into motion that reads as
    /// something happening on this screen.
    ///
    /// The point is not the polish — a fold near the bottom of the screen moves
    /// the row you were reading, and without the tween there is nothing to
    /// follow, so it reads as the row teleporting and has to be hunted for.
    private func toggleFold(_ id: NodeId, proxy: ScrollViewProxy) {
        // Where the row sits in the viewport right now, as a fraction of it.
        // Captured before the op, because applying it is what moves everything.
        let anchor = viewportFraction(of: id)
        withAnimation(.easeOut(duration: 0.2)) {
            apply(.toggleCollapsed(id: id))
        }
        guard let anchor else { return }
        // After the rows have relaid out, put the row back where it was.
        //
        // `scrollTo(id:)` with no anchor would do nothing here: it scrolls only
        // far enough to bring a row *into* view, and this row never left. The
        // anchor is what makes it a position rather than a visibility request —
        // the same distinction the edge-scroll tick ran into.
        //
        // A turn late, since the fold's own layout pass has to land first;
        // asking in the same pass measures the tree we are replacing.
        DispatchQueue.main.async {
            withAnimation(.easeOut(duration: 0.2)) {
                proxy.scrollTo(id, anchor: UnitPoint(x: 0, y: anchor))
            }
        }
    }

    /// Puts the list back on a saved anchor, a turn late so the new scope's
    /// rows have laid out, and unanimated so the position is simply correct on
    /// the first frame rather than seen to travel.
    private func applyAnchor(
        _ anchor: ScrollAnchor, with proxy: ScrollViewProxy, live: Bool
    ) {
        var t = Transaction()
        t.disablesAnimations = true
        withTransaction(t) {
            proxy.scrollTo(anchor.row, anchor: UnitPoint(x: 0, y: anchor.fraction))
        }
        if live { restore = nil }
    }

    /// How far down the viewport a row's top sits, 0 at the top edge and 1 at
    /// the bottom, or nil when the row has not been measured.
    ///
    /// This is what lets a fold keep the row still. Collapsing removes rows
    /// below it, so without this the content closes up and the row rides
    /// wherever the list's own scrolling puts it — which near the bottom means
    /// the row you just tapped jumps away from your finger.
    ///
    /// Two cases it deliberately cannot fix, both because the scroll view has
    /// nowhere to go: a row near the top has no content above it to scroll up
    /// into, and a collapse that shrinks the tree below the viewport makes the
    /// list clamp to its new end. In both the row moves anyway, exactly as it
    /// does today — the anchor is a request, and `scrollTo` honours it only as
    /// far as the content allows.
    private func viewportFraction(of id: NodeId) -> CGFloat? {
        guard let frame = drag.frames[id] else { return nil }
        let bounds = drag.bounds
        guard bounds.height > 0 else { return nil }
        let y = (frame.minY - bounds.minY) / bounds.height
        return min(max(y, 0), 1)
    }

    // MARK: - Adding

    /// Enter the adding run: open an empty row where the next task goes.
    ///
    /// The row *is* the input. There is no separate field to read the text out
    /// of, so this creates the node up front and lets the ordinary rename path
    /// name it — which means one code path for "what a row is called" instead
    /// of two that have to agree.
    ///
    /// The cost of creating first is that an abandoned row is a real node, so
    /// every exit has to clean up after itself. `commitEdit` already deletes a
    /// row emptied by a rename, and that is exactly what an untouched new row
    /// is, so the cleanup comes for free.
    private func startAdding() {
        // On the grid there is no row to type into: `ProjectGrid` draws cards,
        // not editable rows, so a nameless new project would have nowhere to
        // put the name. It gets one straight away and opens, and the run starts
        // on its first task — which is where you were going anyway, since a
        // project with nothing in it is not a destination.
        if scope == nil {
            addProject()
            return
        }
        edit.adding = true
        addRow()
        stageSpare()
    }

    /// Make a project and open its name for typing, on the grid.
    ///
    /// It used to name the project "New project" and jump straight inside,
    /// because the grid had no field to type into. That left every project
    /// carrying a placeholder until someone went back and fixed it — and there
    /// was no way to fix it, since the grid had no rename either. The cards can
    /// hold a field now, so the name is typed where the project is.
    ///
    /// Not `adding`: the mode exists so Return can ask for another row, and a
    /// run of projects is not a thing people do. Return here means done.
    private func addProject() {
        let id = TreeOps.newId()
        apply(.addChild(
            id: id, parentId: nil, text: "",
            at: Date().timeIntervalSince1970 * 1000))
        guard let node = TreeOps.byId(tree, id) else { return }
        beginEdit(node)
    }

    /// Return on a project's name.
    ///
    /// Named projects open, and the task run starts inside — naming a project
    /// and then filling it should not be two trips. An empty name is the user
    /// backing out, and `commitEdit` deletes the node, so there is nothing to
    /// open.
    private func submitProjectName() {
        let id = edit.editing
        // Focus is held rather than released, the same way a run of tasks holds
        // it. iOS takes the keyboard down the moment nothing is focused, so
        // releasing here made the keyboard drop and come straight back up for
        // the first task — with the button animating to a plus and back in the
        // gap. Focus passes from the name field to the row without ever being
        // nil.
        commitEdit(releasingFocus: false)
        guard let id, TreeOps.byId(tree, id) != nil else { return }
        openProject(id)
        // After the scope change, so the first task lands inside the new
        // project rather than beside it. `setScope` clears the run, which is
        // why this comes second.
        edit.adding = true
        addRow()
        stageSpare()
    }

    /// Put the waiting row below whatever `addRow` just opened.
    ///
    /// Separate from `addRow` because not every caller wants one: a plain
    /// rename opens a field with no run behind it, and a spare there would be
    /// an empty row nobody asked for.
    private func stageSpare() {
        guard let open = edit.editing else { return }
        addSpare(below: open)
    }

    /// Leave the run. The open row commits if it has text and is deleted if it
    /// does not — both by the ordinary rename commit, which already draws that
    /// line the same way the web does.
    private func stopAdding() {
        // Before the commit, so the row being typed in is still the one
        // `commitEdit` sees. Dropping the spare is not optional: it is an empty
        // node in the tree, and leaving it is the blank task the rule forbids.
        dropSpare()
        edit.stopAdding()
        commitEdit()
    }

    /// Create the empty row the user types into, below the anchor.
    ///
    /// Placement is the rule the capture field already used: a sibling below
    /// whatever row was last touched, or the bottom of the project when nothing
    /// has been. Depth is deliberately not guessed — a new task goes beside the
    /// last one, never inside it.
    private func addRow() {
        // The id and the timestamp are minted here and carried by the op, so the
        // server applies it to exactly the node this device created.
        let id = TreeOps.newId()
        let anchor = edit.captureParent.flatMap { TreeOps.byId(tree, $0) }
        // Focus moves to the new id *before* the ops, and that ordering is the
        // whole fix. `apply` publishes, and there are two of them, so the list
        // rebuilds twice between the old field and the new one. Claiming focus
        // afterwards leaves a window where the outgoing field is gone and the
        // incoming one is not focused yet — iOS takes the keyboard down the
        // instant nothing holds it, then puts it straight back up, which is the
        // slide-down-slide-up. The simulator hid this by coalescing the
        // publishes into one pass; a phone is slow enough not to.
        //
        // Focusing an id whose row does not exist yet is safe: `focusedRow` is
        // a plain value, and the field binds to it via `.focused(equals:)` when
        // it is built a moment later.
        edit.begin(id: id, text: "")
        focusedRow = id
        apply(.addChild(
            id: id, parentId: anchor?.parentId ?? scope, text: "",
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
        // Not routed through `beginEdit` any more. That path defers focus to
        // the next runloop turn for a row that already exists; here the field
        // is opened up front, deliberately, and re-running it would hand focus
        // over a second time through exactly the gap this avoids.
        // And into view, because the row is inside the scrolling list and the
        // keyboard covers the bottom of it. The old capture bar never needed
        // this: a bar pinned to the bottom edge sits above the keyboard by
        // construction, while a row does not.
        scrollInto(id)
    }

    /// Bring a row clear of the keyboard.
    ///
    /// A turn late, since the row has to exist in the list before it can be
    /// scrolled to.
    ///
    /// Deliberately not `.bottom`: that anchor means the bottom of the
    /// *scroll view*, and the scroll view runs on underneath the keyboard — so
    /// it parked the new row in exactly the strip the keyboard covers, which
    /// looked like no scrolling at all. `.center` is above the keyboard on any
    /// phone and needs no guess about how tall it is.
    private func scrollInto(_ id: NodeId) {
        DispatchQueue.main.async {
            withAnimation(.easeOut(duration: 0.2)) {
                scroller?.scrollTo(id, anchor: .center)
            }
        }
    }

    /// Return, inside the adding run.
    ///
    /// Two meanings, split on whether the row has anything in it. With text it
    /// is "next" — commit and open another below. Empty it is "done", because
    /// there is no next task to ask for and pressing Return twice at the end of
    /// a run is how people stop typing.
    ///
    /// The empty case does not need to delete anything: `commitEdit` removes a
    /// row committed empty, which is what `stopAdding` runs into.
    private func submitAdding() {
        guard !edit.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            stopAdding()
            return
        }
        // Focus moves to a field that is already on screen, and that is the
        // whole point. Creating the next row here and focusing it meant the
        // outgoing field was destroyed before the incoming one had been built,
        // and iOS drops the keyboard the moment no field holds it — the slide
        // down and back up. Nothing about the axis, the List, the two ops or
        // the deferred focus changed that; a harness on a real phone showed
        // all four combinations sliding. The gap itself was the bug, so the
        // fix is to not have one.
        //
        // The spare is a real row in the tree, kept one ahead of the cursor.
        guard let spare = spareRow else {
            // No spare means the run was not started through `startAdding` —
            // fall back to the old path rather than dropping the Return.
            commitEdit(releasingFocus: false)
            addRow()
            return
        }
        commitEdit(releasingFocus: false)
        spareRow = nil
        // Hand over first, then build the next spare behind it. Reversing these
        // puts a list rebuild between the commit and the focus move, which is
        // the gap again.
        edit.begin(id: spare, text: "")
        focusedRow = spare
        scrollInto(spare)
        addSpare(below: spare)
    }

    /// The empty row waiting below the one being typed in.
    ///
    /// It exists so Return has somewhere to land that is already built. Held as
    /// an id rather than a flag because it has to be findable again: it is a
    /// real node, and a run that ends leaves it behind to be removed.
    private func addSpare(below anchorId: NodeId) {
        // Whatever was staged before goes first. Overwriting `spareRow` with a
        // new id orphans the old node: nothing else knows it exists, so no exit
        // can clean it up and it syncs to the web as a blank task. Cheap to be
        // certain here rather than to trust every caller to have cleared it.
        dropSpare()
        let id = TreeOps.newId()
        guard let anchor = TreeOps.byId(tree, anchorId) else { return }
        apply(.addChild(
            id: id, parentId: anchor.parentId, text: "",
            at: Date().timeIntervalSince1970 * 1000))
        if let i = TreeOps.childrenOf(tree, anchor.parentId)
            .firstIndex(where: { $0.id == anchorId }) {
            apply(.moveNode(id: id, parentId: anchor.parentId, index: i + 1))
        }
        spareRow = id
    }

    /// Take the waiting row away. Always paired with leaving the run: an empty
    /// row left in the tree is exactly what the no-blank-tasks rule forbids,
    /// and it would sync to the web as one.
    private func dropSpare() {
        if let id = spareRow, TreeOps.byId(tree, id) != nil {
            apply(.removeNode(id: id))
        }
        spareRow = nil
    }

    /// A deliberate delete, so the subtree is kept and can be restored.
    ///
    /// `trash: true` here and on the project delete, and nowhere else. The other
    /// `removeNode`s are editing mechanics — `dropSpare` taking back a row the
    /// user never typed into, `commitEdit` dropping one left blank — and a trash
    /// full of empty strings is no use for the deletes that matter.
    /// Delete one row. The swipe knows the node; `delete(at:)` is the same thing
    /// reached through `List`'s index-based path.
    private func delete(_ id: NodeId) {
        apply(.removeNode(id: id, trash: true))
    }

    private func delete(at offsets: IndexSet) {
        for index in offsets { apply(.removeNode(id: rows[index].node.id, trash: true)) }
    }

    /// Navigate. Every user-initiated scope change goes through here rather
    /// than assigning `scope`, so "the user has chosen where they are" is
    /// recorded in one place instead of at each call site. The resume path
    /// deliberately does not use this.
    ///
    /// Matches `setScope` in `src/Outliner.tsx`.
    private func setScope(_ id: NodeId?) {
        // Here rather than in the callers that navigate. A run and its anchor
        // are both facts about one scope, so any move out of that scope ends
        // them — and `openProject`/`zoomOut` clearing them individually left
        // the home button, which calls this directly, showing a checkmark on
        // the grid with no run to end.
        if id != scope {
            // Before the commit, for the same reason as `stopAdding`: the
            // waiting row is a real empty node, and navigating away from it
            // would leave a blank task behind in the project being left.
            dropSpare()
            // Committed, not abandoned. `commitEdit` deletes a row left empty
            // and keeps one with text, which is the same line Return draws — so
            // navigating out of a run can never leave a blank task behind.
            commitEdit()
            edit.stopAdding()
            edit.captureParent = nil
        }
        autoScope = false
        // Not when it changes nothing, so back never spends a step standing
        // still.
        //
        // The cap counts visits rather than depth, and visits accumulate much
        // faster: bouncing between two projects a hundred times fills it
        // without ever leaving depth 1. It is generous for that reason — the
        // entries are ids, so the whole trail costs less than one row of text.
        //
        // Past the end `popBack` hands off to the tree parent, so back still
        // works once the trail runs out.
        if id != scope {
            backTrail.append(BackStep(scope: scope, at: topRowAnchor()))
            if backTrail.count > 200 { backTrail.removeFirst() }
        }
        scope = id
    }

    /// Go to the trash.
    ///
    /// A run in progress is committed first, the same as any other move: the
    /// waiting row is a real empty node, and leaving it behind would be a blank
    /// task. `scope` is untouched — the trash draws over it, and back restores
    /// the grid it was opened from.
    private func openTrash() {
        dropSpare()
        commitEdit()
        edit.stopAdding()
        inTrash = true
    }

    /// Open a project: zoom in, and record that it was opened.
    ///
    /// The timestamp is minted here and carried by the op, so the server stores
    /// the instant this device opened it rather than whenever the write landed.
    /// Matches `openProject` in `src/Outliner.tsx`.
    private func openProject(_ id: NodeId) {
        // The run and the anchor are cleared by `setScope`, which every
        // navigation goes through.
        setScope(id)
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
                .padding(.horizontal, Space.block)
                .padding(.vertical, Space.row)
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
            // `h` is the cell, but this is a background of the content box,
            // which starts half the row padding lower. Without the lift every
            // segment hangs that far below its own row and the joins gap.
            .offset(y: -OutlineRow.rowPadding / 2)
        }
    }

    /// The row whose guide the dragged row would hang from, or nil when no gap
    /// drop is live.
    ///
    /// Identified by node, not by depth: depth alone matches every guide on
    /// that level, lighting all the future parent's siblings. `parentAtDepth`
    /// walks the same lineage `insertAtDepth` does, so the lit guide and the
    /// landing place cannot disagree.
    ///
    /// The guide and the parent row light from this in both modes — one answer
    /// shown twice, so a drag knows where it is landing even when the parent
    /// has scrolled off.
    ///
    /// A drop at depth 0 lights nothing, which is correct rather than missing:
    /// a root row has no parent to hang from.
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
    /// down to the insertion point is the path the dropped row would take —
    /// lighting the rest says the row might land anywhere in there. Cutting it
    /// at the drop point makes the lit length itself the answer.
    ///
    /// `.into` is not cut: nesting lights the row rather than a guide, and
    /// `parentHighlight` carries that case.
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
        // The tap that lands on releasing a drag is the drop, not a request to
        // rename. See `ReorderDrag.justEnded` for why the Button fires at all.
        guard !drag.justEnded else { return }
        let wasEditing = edit.isEditing
        edit.begin(node)
        // Still a turn late, and it has to be: `editing` is what builds the
        // field, so focusing in the same pass targets one that does not exist.
        //
        // The keyboard survives the gap anyway, because the *old* field is
        // still focused across it — the blur no longer clears `focusedRow`,
        // so focus passes from one row to the next without ever being nil.
        // Focus is set in the same runloop turn when a field is already up.
        // The deferral exists because `editing` is what builds the field, but
        // SwiftUI has already applied `edit.begin` by the time this runs inside
        // a transaction — and going through `async` there is precisely the gap
        // where no field is focused and iOS takes the keyboard down.
        if wasEditing {
            focusedRow = node.id
        } else {
            DispatchQueue.main.async { focusedRow = node.id }
        }
    }

    /// Finish renaming. `AnsaCore.commitEdit` decides whether that is a rename,
    /// a delete, or nothing at all — the same rule the web applies, so a row
    /// emptied on the phone disappears exactly as it would in the browser.
    ///
    /// Both Return and tapping away land here.
    ///
    /// - Parameter from: the row the caller believes it is committing. A blur
    ///   arrives after the field has gone, so by then `editing` may already
    ///   name a different row; committing that one would end an edit the user
    ///   just started.
    /// - Parameter releasingFocus: false when the blur came from focus moving
    ///   to another row. iOS dismisses the keyboard the moment nothing is
    ///   focused, and the next field cannot claim it until it has been built —
    ///   so clearing focus here slid the keyboard away and back between every
    ///   two rows.
    private func commitEdit(from: NodeId? = nil, releasingFocus: Bool = true) {
        guard edit.shouldCommit(from: from), let id = edit.editing else { return }
        let op = TreeOps.commitEdit(tree, id, edit.text)
        if let op { apply(op) }

        // Remember it only if it still exists: an emptied row is deleted by
        // `commitEdit`, and anchoring to a node that just went away would send
        // the new task back to the bottom with the chip still claiming
        // otherwise.
        edit.endEdit(rememberAnchor: TreeOps.byId(tree, id) == nil ? nil : id)
        if releasingFocus { focusedRow = nil }
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
    /// Moves whichever row is currently in the air.
    ///
    /// Global coordinates, matching the measured row frames — see `dragMoved`.
    private var carryGesture: some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .global)
            .onChanged { g in
                guard drag.isActive, backPull == 0 else { return }
                dragMoved(g.location)
            }
            .onEnded { _ in
                guard drag.isActive else { return }
                endDrag()
            }
    }

    private var zoomOutSwipe: some Gesture {
        // Recognised from the first point, not 20pt in. A row's leading
        // `swipeActions` reveals well inside 20pt, so a gesture that only
        // announced itself at 20 announced it too late — the row had already
        // opened its zoom button under a screen starting to slide away.
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .onChanged { g in
                // Two separate questions, and the whole fix is that they are no
                // longer one. `claims` asks only where the touch began, so it is
                // true on the very first callback, before the finger has moved
                // at all — which is the only moment early enough to shut the row
                // out. `armed` additionally asks which way the finger is going,
                // which cannot be known yet and so cannot gate the claim.
                if claims(g) { backHolding = true }
                guard armed(g) else { return }
                // One-to-one all the way to the threshold, damped only past
                // it. The damping used to start at 60pt, well short of where
                // the gesture commits, so for most of the pull the edge you
                // watch and the finger you move were different distances —
                // which is what made the commit point unreadable and a cancel
                // feel impossible: retreating moved the edge back at a third
                // the rate it went out.
                //
                // Past the commit point it is overscroll and nothing depends
                // on it, so the pull can slow there without hiding anything.
                let d = g.translation.width
                backPull = d <= backThreshold
                    ? d
                    : backThreshold + (d - backThreshold) * 0.35
                // No haptic at the crossing, deliberately. The row swipe taps
                // at its threshold and this used to match it for consistency,
                // but the system's own interactive pop is silent — and this
                // gesture is measured against every other app on the phone,
                // not against the row swipe.
            }
            .onEnded { g in
                // Released, so the row swipe is available again — a cancelled
                // back swipe hands the row back rather than leaving it inert.
                backHolding = false
                guard armed(g), g.translation.width > backThreshold else {
                    // Short of the threshold: back where it came from, which is
                    // what tells you the gesture was seen and declined.
                    withAnimation(.easeOut(duration: 0.22)) { backPull = 0 }
                    return
                }
                // Carry it the rest of the way out before swapping, so the view
                // leaves rather than snapping back while the new scope appears
                // underneath. The reset is unanimated and rides with the scope
                // change, so the incoming view is in place the frame it
                // appears.
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
    /// The shade the revealed screen sits under. At full brightness it reads
    /// as sitting *beside* the screen being moved rather than behind it.
    @ViewBuilder private var backdrop: some View {
        // Gated on the pull, not just dimmed by it. The shade is drawn at
        // `1 - t`, so at rest it is at *full* strength — left in the tree
        // unguarded it does not sit dormant waiting for a swipe, it sits there
        // black.
        if backPull > 0 {
            // How far through the useful part of the pull we are, 0...1.
            let t = min(1, Double(backPull) / Double(backThreshold))
            // Darkest at the left edge, where the gap has been open longest.
            //
            // Deeper than it looks like it needs, because of dark mode: black
            // over a near-black ground has very little room to work, and the
            // shade that reads clearly on white is close to invisible there.
            //
            // Cubed rather than linear, which keeps the shade near full through
            // the first half of the pull and drops it late. Linear spent its
            // range too early, so by the time the gap was wide enough to look
            // into, the shade had mostly gone.
            let k = pow(1 - t, 3)
            LinearGradient(
                colors: [.black.opacity(0.78 * k), .black.opacity(0.34 * k)],
                startPoint: .leading, endPoint: .trailing)
                .ignoresSafeArea()
                .allowsHitTesting(false)
        }
    }

    /// The fraction of the slab's width its edge must cross to zoom out.
    ///
    /// The edge you can see, not the finger: the pull is damped to 0.35, so a
    /// threshold on the finger costs far more thumb travel than it looks, and
    /// pulling back to cancel barely moves the edge.
    ///
    /// Shares the row delete's `commitFraction` because the two gestures live
    /// on the same rows and should not commit at visibly different distances.
    private let backFraction: CGFloat = 0.25

    /// How far the view must travel before letting go zooms out.
    ///
    /// Derived, so it is 35% of whatever is actually on screen rather than 35%
    /// of the phone this was written on.
    private var backThreshold: CGFloat { slabWidth * backFraction }

    /// Far enough right to be clear of the screen on any phone.
    private let slideOut: CGFloat = 700

    /// How far in from the edge a touch still counts as a possible back swipe.
    private let backClaim: CGFloat = 64

    /// Whether this touch began somewhere a back swipe could start.
    ///
    /// Position only. Direction is not known on the first callback and the
    /// row's own swipe reveals before it becomes known, so anything waiting for
    /// direction is already too late — the near edge is claimed the moment a
    /// finger lands there.
    ///
    /// Wider than `armed`'s 32pt on purpose: a thumb coming off the bezel
    /// habitually lands past 32, so a strip covering only where the pull *acts*
    /// leaves the row open across the band where it is attempted.
    private func claims(_ g: DragGesture.Value) -> Bool {
        canGoBack && !drag.isActive && !rowSwiping && g.startLocation.x < backClaim
    }

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
        canGoBack
            // Not while a row is in the air. The two gestures are recognised
            // simultaneously, so without this a swipe can begin under a drag
            // that is already running and the row would follow a finger that
            // is busy moving the whole screen out from under it.
            && !drag.isActive
            // Nor while a row is being swiped. A delete already under way owns
            // the touch until the finger lifts — navigating back has to be a
            // new gesture, not the tail of that one.
            && !rowSwiping
            && g.startLocation.x < 32
            && goingSideways(g)
    }

    /// Whether the finger is travelling sideways rather than down.
    ///
    /// Not `abs(height) < abs(width)`. That is evaluated on the *first*
    /// callback, 20pt in, and a thumb coming off the bezel arcs — so one early
    /// sample disqualified the whole gesture and the swipe had to be aimed.
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
        // The trash is one step above the grid and holds no run, so leaving it
        // is only this — the trail below it is the scope you were in before
        // you came to the grid, and back from the trash must not spend it.
        if inTrash {
            inTrash = false
            return
        }
        // Zooming out changes where a new task would land, so the run and its
        // anchor both go with it. Done here rather than inherited from
        // `setScope`, because this deliberately does not call it: `setScope`
        // would push the step being undone and leave back bouncing between two
        // scopes.
        dropSpare()
        commitEdit()
        edit.stopAdding()
        edit.captureParent = nil
        autoScope = false
        let step = popBack()
        scope = step.scope
        restore = step.at
    }

    /// Take the next step back, spending it. `peekBack` decides where; this
    /// clears the trail down to it.
    private func popBack() -> BackStep {
        let step = peekBack
        // Drop everything down to and including what the peek settled on, so
        // the skipped-over dead scopes do not sit waiting for the next back.
        if let i = backTrail.lastIndex(where: { $0.scope == step.scope }) {
            backTrail.removeSubrange(i...)
        } else {
            backTrail.removeAll()
        }
        return step
    }

    /// Where back would land, without spending the step.
    ///
    /// The preview behind a back swipe reads this so it draws the screen you
    /// will actually get. It used to take the top of the trail raw, which is a
    /// different answer whenever the entry above points at a deleted scope —
    /// one screen slid in and another landed.
    ///
    /// Deleted scopes are skipped rather than landed on: a trail outlives the
    /// nodes in it, and stepping back into something that is gone shows an
    /// empty screen that reads as the app failing.
    private var peekBack: BackStep {
        for step in backTrail.reversed() {
            guard let id = step.scope else { return step }
            if TreeOps.byId(tree, id) != nil { return step }
        }
        // Off the end of the trail: the tree parent, with nowhere remembered.
        return BackStep(scope: parentScope, at: nil)
    }

    /// The topmost row on screen and how far down the viewport it sits — enough
    /// to put the list back where it was, and stable across edits in a way a
    /// raw content offset is not. Nil when nothing has been measured yet.
    private func topRowAnchor() -> ScrollAnchor? {
        let bounds = drag.bounds
        guard bounds.height > 0 else { return nil }
        let top = drag.frames
            .filter { $0.value.maxY > bounds.minY }
            .min { $0.value.minY < $1.value.minY }
        guard let top, let fraction = viewportFraction(of: top.key) else { return nil }
        return ScrollAnchor(row: top.key, fraction: fraction)
    }
}

/// The capture button's disc: Liquid Glass where the OS has it, and the
/// material it used before everywhere else.
///
/// A fork on availability rather than a raised deployment target. The glass is
/// one control's appearance, and the floor is what decides which phones can run
/// the app at all — not a trade worth making for a button.
///
/// The system's glass draws its own shading, so the hand-rolled shadow goes with
/// it: kept underneath, it reads as a second, flatter disc behind the real one.
private struct CaptureButtonSurface: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content.glassEffect(.regular.interactive(), in: .circle)
        } else {
            content
                .background(Circle().fill(.regularMaterial))
                .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
        }
    }
}

/// Where a list was left, as a row and how far down the viewport it sat.
///
/// A node and a fraction rather than a content offset, because the tree can
/// change while you are away: rows get added, deleted and reordered, and an
/// offset that was right on the way in points somewhere else on the way back.
/// A row that no longer exists simply fails to scroll, which leaves the list at
/// the top — the behaviour there was before any of this.
struct ScrollAnchor: Equatable {
    let row: NodeId
    let fraction: CGFloat
}

/// One step of the back trail: the scope, and where the list was looking.
struct BackStep {
    let scope: NodeId?
    let at: ScrollAnchor?
}

/// The scope's progress, as a thin row under the nav bar.
///
/// Split back out of the title. The bar and the figure were folded into the
/// header to save the ~60pt an earlier strip cost, but that strip also repeated
/// the scope's name and stacked a caption under it — so the saving came out of
/// the title's height, and the name ended up smaller than anything it labels.
///
/// This is the figure without the repetition: one line, no name, so it costs
/// about a third of what it replaced and hands the whole header back to the
/// title.
private struct ScopeProgress: View {
    let progress: TreeOps.Progress?

    private var complete: Bool { progress?.pct == 100 }

    /// Nil and 0% are the same claim here, as in the title: both mean nothing
    /// done yet. Drawn either way so the row never changes height.
    private var fraction: Double {
        guard let progress, progress.total > 0 else { return 0 }
        return Double(progress.done) / Double(progress.total)
    }

    /// A figure at every value, including the last one. "All done" read as a
    /// different kind of thing sitting where a number had been — and the colour
    /// and the full bar beside it already say finished.
    private var label: String {
        "\(progress?.pct ?? 0)%"
    }

    var body: some View {
        HStack(spacing: Space.row) {
            // The bar the header dropped. At a glance it says "some" or
            // "most"; the figure beside it says which — the pair is why this
            // is worth a row where either alone was not.
            GeometryReader { geo in
                Capsule()
                    .fill(.quaternary)
                    .overlay(alignment: .leading) {
                        Capsule()
                            .fill(complete ? Color.done : Color.accentColor)
                            .frame(width: geo.size.width * fraction)
                    }
            }
            .frame(height: 4)

            Text(label)
                .font(.caption)
                // `.secondary`, not `.tertiary`. Tertiary is 26% opacity —
                // about 1.8:1 in light mode and 2.2:1 in dark, against the
                // 4.5:1 text this size needs. It is Apple's tint for
                // decoration, and this is a figure meant to be read.
                .foregroundStyle(
                    complete ? AnyShapeStyle(Color.done) : AnyShapeStyle(.secondary))
                .monospacedDigit()
                .contentTransition(.numericText())
        }
        .padding(.horizontal, Space.gutter)
        .padding(.vertical, Space.inner)
        // The fill and the figure move together when a tick changes the count.
        .animation(.easeOut(duration: 0.35), value: progress?.pct)
    }
}

/// The scope's name and how far into it you are, as the nav bar's own title.
///
/// One header instead of two. The name used to appear twice — once as the last
/// crumb, once atop a progress strip below — and the strip cost ~60pt to say a
/// thing the title bar was already saying.
///
/// The bar went with it. What was worth keeping was the figure, not the shape:
/// a 4pt capsule reads as "some" or "most", where `45% done` is the actual
/// answer and takes less room to give.
private struct ScopeTitle: View {
    let title: String
    /// A drop at depth 0 would land as a top-level task in this project. Not
    /// nesting into the project the way one row nests into another — the
    /// project is the list, not a task in it — but it is the same question a
    /// drag is asking, so it gets the same answer.
    let lit: Bool
    /// Root-first, current scope last, as `TreeOps.lineageOf` gives it.
    /// Empty on the project grid, where there is no path.
    let path: [Node]
    let onTap: (NodeId?) -> Void

    /// Renaming happens in the header because the header *is* the scope's row:
    /// zooming in is exactly what turned that row into this title.
    let editing: Bool
    @Binding var editText: String
    /// The title's focus, not the list's `focusedRow`, which is aimed at rows.
    /// Owned by the parent and passed in: a `@FocusState` declared here is
    /// reset whenever the tree changes and rebuilds this struct.
    let typing: FocusState<Bool>.Binding
    /// Return, and tapping away, both mean the same thing here — the same rule
    /// a row follows. It decides whether that is a rename, a delete, or
    /// nothing at all.
    let onCommit: () -> Void

    var body: some View {
        // The path vertically, on demand, rather than horizontally and always.
        //
        // The crumb trail this replaces spent the width of the bar on a route
        // you mostly already know, and elided its middle exactly when the trail
        // got long enough to be worth reading. A menu has as many lines as the
        // path has steps.
        //
        // It also fixes what the width was costing: a crumb is a small target
        // beside other small targets, so leaving a scope by tapping the wrong
        // one was easy. Opening the menu is deliberate, and every row in it is
        // full width.
        if editing {
            nameField
        } else {
            pathMenu
        }
    }

    /// The name, as a field, in the name's place. Nothing moves when a rename
    /// starts — which is the point of doing it here rather than in a sheet.
    private var nameField: some View {
        // No stack any more: the figure is in the row below the bar, so the
        // field is the whole title the same way the name is.
        Group {
            TextField("Name", text: $editText)
                .textFieldStyle(.plain)
                .font(.subheadline.weight(.semibold))
                .multilineTextAlignment(.center)
                .focused(typing)
                .submitLabel(.done)
                .onSubmit(onCommit)
                .onAppear { typing.wrappedValue = true }
                // Tapping away commits, the same as Return. Without this the
                // field would just go and the typing would be lost.
                .onChange(of: typing.wrappedValue) { was, now in
                    if was, !now { onCommit() }
                }
        }
        .frame(maxWidth: max(titleWidth, 0))
        .padding(.vertical, Space.tight)
    }

    private var pathMenu: some View {
        Menu {
            // Top down, outermost first — the path read the way it is written,
            // and the way the crumb trail read left to right. Nearest-first
            // puts the commonest jump under the finger, but it also inverts
            // the one thing the menu is for: showing where you are in a
            // hierarchy. Back already covers one step up.
            //
            // Projects heads the list because it is the top of the path, not
            // an escape bolted to the end.
            Button {
                onTap(nil)
            } label: {
                Label("Projects", systemImage: "house")
            }

            // No glyph on these. The same arrow beside every row distinguishes
            // nothing, and the order already says which way the path runs.
            ForEach(ancestors) { node in
                Button(node.text.isEmpty ? "Untitled" : node.text) {
                    onTap(node.id)
                }
            }
        } label: {
            titleLabel
        }
        // A `Menu` tints its label with the accent colour, and that tint is
        // what the label's own `.primary`/`.secondary` then resolve against —
        // so the title came out blue and the status line a pale blue at about
        // 1.8:1. `.tint(.primary)` puts the stack back on the label palette;
        // `titleLabel` still paints itself, and `lit` still overrides for a
        // drop.
        .tint(.primary)
        // Off on the grid, where the path is empty and there is nowhere to go.
        .disabled(path.isEmpty)
    }

    /// The path above the current scope. The scope itself is the title, and
    /// offering it would be a row that navigates nowhere.
    private var ancestors: [Node] {
        path.dropLast()
    }

    /// How wide the title may be: the screen less the space the leading and
    /// trailing buttons occupy. Back is a chevron and the exit is a house, so
    /// the reserve is the same on both sides and the title stays centred.
    private var titleWidth: CGFloat {
        UIScreen.main.bounds.width - buttonZone * 2
    }

    /// A toolbar button's tap target plus the bar's own edge inset. Nothing
    /// exposes this, so it is measured: the chevron sits ~16pt from the edge
    /// and is ~44pt wide.
    ///
    /// The box runs to exactly this, with no gutter subtracted. The air between
    /// the box and the buttons is the buttons' own inset; taking a gutter off
    /// as well made the box smaller than the space it was meant to fill.
    private let buttonZone: CGFloat = 60

    /// A toolbar button's tap target, which is what the box matches.
    ///
    /// The box is meant to be the biggest one that fits between the buttons, so
    /// its height is theirs: 44 is the standard target, and anything taller
    /// would be a box the bar has no room for.
    private let buttonHeight: CGFloat = 44

    private var titleLabel: some View {
        // One line, not a stack. The figure moved to its own row under the bar,
        // which is what lets the name have the whole height here instead of
        // splitting it with a caption.
        HStack(spacing: 4) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
                .truncationMode(.tail)

            // The mark that says the name is a control. Without it the
            // title reads as a label and the menu never gets found.
            if !path.isEmpty {
                Image(systemName: "chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
        }
        .foregroundStyle(
            lit ? AnyShapeStyle(DropPalette.nest) : AnyShapeStyle(.primary))
        // As wide as the bar allows. A drop on the header is easy to miss when
        // the target is only as wide as the name — "Fds" lit up is a thumbnail
        // — and a target that changes size with the title is one you have to
        // look at to aim. This is the same rectangle every time.
        //
        // Two boxes, nested: the inner keeps the name off the border, the
        // outer is the target. The padding comes out of the room the title had
        // rather than out of the box's size.
        .padding(.horizontal, Space.row)
        // The biggest box that fits: the bar's width less the two button
        // zones, at the height of a button. A frame, not padding — padding
        // makes the box a function of the name, and this one is a function of
        // the bar, so it is the same rectangle whatever the title says.
        //
        // `width`, not `maxWidth`. A `maxWidth` only *permits* the width, and
        // `.principal` sizes to its content — so with a single truncated line
        // inside, the item asked for the width of the name and got it: a short
        // title got a short box. Spacers do not help, because the stack is
        // already only as wide as the frame it was given. This demands the
        // width instead, which is the one thing that makes the box a function
        // of the bar rather than of the name.
        .frame(width: max(titleWidth, 0), height: buttonHeight)
        .background {
            // Only under a drop. At rest the header is a title, and a box
            // drawn around it all the time reads as a permanently half-pressed
            // button — worse, it spends the drag's own colour on a resting
            // state, which is the one thing `DropPalette` exists to prevent.
            if lit {
                RoundedRectangle(cornerRadius: 9)
                    .fill(DropPalette.nest.opacity(0.14))
                    .overlay(
                        RoundedRectangle(cornerRadius: 9)
                            .strokeBorder(DropPalette.nest, lineWidth: 2))
            }
        }
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
        .padding(.vertical, Space.row)
        .background(.quaternary)
    }
}

/// One row: checkbox, bullet, text. Progress moved to a single bar for the
/// whole scope, matching the web app, which never showed a count per row.


/// The vertical paddings this file is allowed to use.
///
/// A padding is one of these or it is derived from a target height; there is no
/// third way to get a number.
///
/// Multiples of 4, the grid the platform's own metrics land on. The exception is
/// `OutlineRow.rowPadding` at 14, derived from the touch target — see its
/// comment.
///
/// No horizontal scale: `railInset` and `columnLeft` derive from where the marks
/// sit, and `gutter` only has to agree with the screen edge.
extension Binding where Value == Bool {
    /// The same binding, with every write wrapped in an animation.
    ///
    /// For the home screen's folds, whose state is `@AppStorage`. A write there
    /// goes out to `UserDefaults` and arrives back as a change notification,
    /// which is not the transaction SwiftUI would have animated — so the
    /// section's rows appear and vanish on a single frame. Animating at the
    /// binding covers the write wherever it comes from, including the chevron's
    /// own, which is not ours to wrap.
    var animated: Binding<Bool> {
        Binding(
            get: { wrappedValue },
            set: { newValue, _ in
                withAnimation(.easeOut(duration: 0.2)) { wrappedValue = newValue }
            })
    }
}

enum Space {
    /// Squeezed against a taller neighbour. Two lines in a bar sized for one.
    static let tight: CGFloat = 2

    /// A row inside a container that already carries its own padding.
    static let inner: CGFloat = 4

    /// A single-line row that stands on its own and takes a tap.
    static let row: CGFloat = 8

    /// A block set apart from what surrounds it.
    static let block: CGFloat = 12

    /// The shortest a row on the home screen is allowed to be.
    ///
    /// Above Apple's 44pt minimum, which the rows already met on content alone
    /// — this is for the room, not the tap target. A minimum rather than a
    /// fixed height: the rows hold different things, and at large Dynamic Type
    /// a fixed one would clip whichever row outgrew it.
    static let tap: CGFloat = 48

    /// The screen edge. Anything that has to line up with another section's
    /// left edge measures from here.
    static let gutter: CGFloat = 16
    /// How far a corner control sits from the two screen edges it floats over.
    static let corner: CGFloat = 36
}

private struct OutlineRow: View {
    let node: Node
    let depth: Int
    let hasChildren: Bool
    let editing: Bool
    @Binding var editText: String
    @FocusState.Binding var focusedRow: NodeId?
    let onToggleDone: () -> Void
    let onCollapse: () -> Void
    /// This row's offset into the completion ripple, or nil when it isn't in
    /// one. See `RippleWiggle`.
    let rippleDelay: Double?
    /// True when this row is done *and* so is the group around it, which is
    /// what colours the box green. See `DonePalette`.
    let groupDone: Bool
    /// Whether this field belongs to a run of new tasks rather than a rename.
    /// Only the Return key's label depends on it.
    let adding: Bool
    let onBeginEdit: () -> Void
    let onBlur: (NodeId) -> Void
    let onSubmit: () -> Void
    /// Drag, reported in global coordinates. The row does not know where the
    /// list starts, so the view that owns the hit-test rebases these.
    let onDragBegan: () -> Void
    /// True while this row is the one being carried, which dims it in place.
    let isDragging: Bool
    /// True while a drop would land inside this row, which lights its bullet.
    let isDropTarget: Bool
    /// Delete this row. Fired by the swipe below rather than by a button, so
    /// the row owns the whole gesture — see `rowSwipe`.
    let onDelete: () -> Void
    /// Zoom into this row, the leading edge's half of the same gesture.
    let onZoom: () -> Void
    /// True while a back swipe holds the touch, which shuts this row's swipe
    /// for as long as it runs. The same suppression the leading edge takes.
    let backHolding: Bool
    /// Announce that this row's swipe has taken the touch, or given it back.
    /// The list shuts the back swipe out for as long as it is true.
    let onSwipingChanged: (Bool) -> Void
    /// This row's piece of the nesting lines, built by the call site.
    ///
    /// Handed in rather than drawn there, because it has to sit inside this
    /// view's `.offset` to travel with the row. It cannot be built here: it
    /// needs the whole visible row list and the drag's frames, neither of
    /// which a single row has.
    let guides: AnyView
    /// The width the commit threshold is a fraction of.
    ///
    /// The screen's, not the row's. A threshold asks how much effort confirms
    /// the action, and effort is how far a finger travels — so it has to be
    /// the same distance on every row. A fraction of the row made a nested one
    /// commit sooner than its parent purely because the indent had made it
    /// narrower, which is the indent deciding how hard it is to delete.
    let screenWidth: CGFloat

    /// This view's own height — the row's *content*, without the vertical
    /// padding the call site wraps it in. `cellHeight` is this plus that.
    ///
    /// Measured, because a title that wraps to two lines is taller than one
    /// that does not, and a constant can only be right for one of them. That
    /// was the bug this replaced: a fixed 54 was correct for a single line
    /// and short for every wrapped row.
    ///
    /// Seeded at the single-line content height so a freshly appeared row's
    /// first swipe frame is not a zero-height strip.
    @State private var contentHeight: CGFloat = 40
    /// True from the moment this row's press arms a drag until the carry ends.
    ///
    /// Derived from `isDragging` rather than held as state: the list owns the
    /// drag now, so a local flag would need clearing from a gesture this view
    /// no longer has — and a stale one silently eats the next fold-tap.
    private var armed: Bool { isDragging }

    /// The bullet's gesture: a tap folds.
    ///
    /// The drag used to live here too, as a second recognizer combined with
    /// `.simultaneously`. It moved to the row — so this is now just a tap, and
    /// `armed` is what keeps it from firing on the way out of a drag that
    /// started over the bullet.
    ///
    /// Still a gesture rather than a Button: the row's press has to be able to
    /// run alongside it, and a Button consumes the touch outright.
    private var bulletGesture: some Gesture {
        TapGesture()
            .onEnded { if !armed && hasChildren { onCollapse() } }
    }

    /// The press that picks this row up.
    ///
    /// Only the press lives on the row — the carry is one recogniser on the
    /// list, because the row needs to say *which* row while movement is the
    /// same question for all of them. Per-row drags were what starved
    /// scrolling: every row a finger touched added one contending for the
    /// touch, and `List`'s pan lost to the crowd.
    ///
    /// `maximumDistance` lets a finger that is really scrolling abandon the
    /// press before it fires.
    private var armGesture: some Gesture {
        LongPressGesture(minimumDuration: 0.35, maximumDistance: 10)
            .onEnded { _ in onDragBegan() }
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
    /// Measured from the list's leading edge, not the row's content box, so it
    /// carries `railInset`. The guides are drawn in the list's coordinate space
    /// while the inset is padding *inside* each row — nothing propagates it
    /// across, so it has to be part of this number or every line sits a rail's
    /// width left of the bullets it is supposed to run through.
    static let guideX0: CGFloat = railInset + 16

    /// X of the bullet column's left edge — where the bars above and below the
    /// outline start, so the column reads as sitting on one vertical line.
    ///
    /// The *ring*'s edge, not the dot's. A leaf shows a 6pt dot but a parent
    /// draws an 18pt ring, so aligning to the dot would leave that ring hanging
    /// out into the margin. The bars sit at the widest mark the column can
    /// draw.
    static let columnLeft: CGFloat = railInset + (32 - 18) / 2

    /// How far the whole row sits in from the screen's leading edge.
    ///
    /// `listRowInsets` is zeroed so a guide segment can fill its row, which
    /// takes the leading margin with it. This puts it back.
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
    static let rowHeight: CGFloat = 28

    /// The row's own vertical spacing, split evenly above and below its
    /// content. Declared here rather than left to `List`: with the row insets
    /// zeroed, the row frame is the whole cell, which is what lets a guide
    /// segment fill its row and still meet the segments above and below.
    ///
    /// Together with `rowHeight` this is 42pt a row, down from 62. The floor is
    /// the 44pt touch target the bullet and checkbox need, which they still
    /// clear on their own frames — the row is shorter than its controls, not
    /// the other way round. Going to the 22pt a line of text strictly needs
    /// would make both marks genuinely hard to hit.
    static let rowPadding: CGFloat = 14

    /// The height of a single-line cell: the row's own 40pt minimum plus the
    /// vertical padding the call site adds around it. Measured at 54.
    ///
    /// Kept for the callers that need a row's height before one exists. The
    /// swipe strip does not use it — it measures, since a wrapped row is
    /// taller than this.
    static let cellHeight: CGFloat = 40 + rowPadding

    /// The row's marks and label. Split out from `body` only because the two
    /// together sat over the type checker's limit for one expression.
    private func rowContent(justSwiped: Bool) -> some View {
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
            Bullet(hasChildren: hasChildren, collapsed: node.collapsed,
                   lit: isDropTarget)
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
                Checkbox(done: node.done, groupDone: groupDone)
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
                        // What Return actually does here, which is not the
                        // same in both modes: it finishes a rename, and it asks
                        // for another row in a run. The key said "done" in both
                        // and was therefore labelled as the opposite of what it
                        // did while adding.
                        .submitLabel(adding ? .next : .done)
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
                    // Deaf while a swipe is open or springing home — see
                    // `RowSwipeView.justSwiped`, which is where the flag
                    // handed in here comes from.
                    Button(action: { if !justSwiped { onBeginEdit() } }) {
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
    }

    var body: some View {
        RowSwipeView(
            rowId: node.id,
            vPadding: Self.rowPadding / 2,
            screenWidth: screenWidth,
            // A carry or a back swipe owns the touch outright; this one stands
            // down rather than competing for it.
            inert: isDragging || backHolding,
            onDelete: onDelete,
            onZoom: onZoom,
            onSwipingChanged: onSwipingChanged
        ) { justSwiped in
            rowContent(justSwiped: justSwiped)
                .padding(.leading,
                         Self.railInset + CGFloat(depth) * Self.indent)
                // On the marks and the text, never on the row: the guides
                // are a `.background` one step further out, so a wiggle
                // applied outside them would sway the lines along with the
                // marks and the whole structure would appear to lean.
                .modifier(RippleWiggle(delay: rippleDelay))
                // Inside the swipe's content, so the guides travel on the same
                // offset as the marks and the text. They used to be a
                // `.background` of the cell one level out, slid by a copy of
                // the offset shipped to the call site through a closure — a
                // second path to the same number, outside the `withAnimation`
                // that eases it home, which is why the lines jumped while the
                // row slid.
                .background(alignment: .topLeading) { guides }
        }
        // Measured rather than assumed. This is the content box, not the cell —
        // the call site's vertical padding sits outside it, so whoever reads
        // `contentHeight` adds it back. A line's worth, or two of them,
        // depending on how far the title wrapped.
        .background {
            GeometryReader { geo in
                Color.clear
                    .onAppear { contentHeight = geo.size.height }
                    .onChange(of: geo.size.height) { _, h in contentHeight = h }
            }
        }
        // The whole row arms a drag, not just the bullet — the 0.35s hold
        // already separates a drag from everything else the row does. One
        // gesture, not one per column: two sequenced presses recognising at
        // once over the bullet both armed the drag and lost its tracking.
        //
        // `.simultaneousGesture`, never `.highPriorityGesture`: the label is a
        // Button covering most of the row, and taking the touch is exactly what
        // stops a Button firing.
        //
        // No `.contentShape` here. It looks like it belongs, but a shape on the
        // cell makes the row an opaque hit-test surface *ahead of* `List`,
        // which swallows the scroll and the row's own swipe.
        .simultaneousGesture(armGesture)
        // No row separators — the vertical guides are the only lines in the
        // outline. `List` draws them by default.
        .listRowSeparator(.hidden)
        // Faded while carried, so the row in flight is visibly the one under
        // the finger. It stays in place rather than following: the tree has to
        // stay readable to aim at.
        .opacity(isDragging ? 0.35 : 1)
        .animation(.easeOut(duration: 0.12), value: isDragging)
        // Outlined as well as washed: a stroke reads at far lower contrast than
        // a fill, so the same faint grey still draws a legible edge.
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
    /// True when the group this row sits in is finished too, which turns the
    /// box green rather than blue. See `DonePalette`.
    let groupDone: Bool

    /// Not `.tint`: the two done states have to be told apart by colour, and
    /// the accent is the user's own choice — it could be either of them, or
    /// neither. Everything that is not a done state still follows the accent.
    private var fill: Color { groupDone ? DonePalette.group : DonePalette.task }

    var body: some View {
        RoundedRectangle(cornerRadius: 5)
            .strokeBorder(done ? AnyShapeStyle(.clear) : AnyShapeStyle(.secondary), lineWidth: 2)
            .background(
                RoundedRectangle(cornerRadius: 5)
                    .fill(done ? AnyShapeStyle(fill) : AnyShapeStyle(.clear)))
            .frame(width: 19, height: 19)
            .overlay {
                if done {
                    Image(systemName: "checkmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(.background)
                }
            }
            // Faded, not cut. When a tick completes a group every box in it
            // goes blue→green at once, and the fade is what makes that read as
            // one event rather than a flicker. Matches the web's 0.25s.
            .animation(.easeInOut(duration: 0.25), value: groupDone)
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
    /// True while a drop would land inside this row, which lights the mark.
    var lit: Bool = false

    var body: some View {
        ZStack {
            if hasChildren {
                if collapsed {
                    // The disc is now the only thing saying children are hidden
                    // here — both the chevron and the count came off the row.
                    Circle()
                        .fill(lit ? AnyShapeStyle(DropPalette.nest)
                                  : AnyShapeStyle(.secondary))
                        .frame(width: 18, height: 18)
                } else {
                    Circle()
                        .strokeBorder(lit ? AnyShapeStyle(DropPalette.nest)
                                          : AnyShapeStyle(.secondary),
                                      lineWidth: 2)
                        .frame(width: 18, height: 18)
                }
            } else if lit {
                // A leaf has no surround to light, so it grows the ring the
                // expanded state already has. Same shape, so the row about to
                // become a parent previews what it is about to look like.
                Circle()
                    .strokeBorder(DropPalette.nest, lineWidth: 2)
                    .frame(width: 18, height: 18)
            }
            // Never lit. The dot is the one part that means the same thing in
            // every state, and a brass dot on a brass disc would erase it.
            Circle()
                .fill(.primary)
                .frame(width: 6, height: 6)
        }
        .frame(width: 18, height: 18)
        .animation(.easeOut(duration: 0.12), value: lit)
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
    /// The project whose name is being typed, or nil. The grid draws a field in
    /// place of that card's title; every other card is unchanged.
    let editing: NodeId?
    @Binding var editText: String
    /// Focus lives on the parent so one binding covers rows and cards alike —
    /// `@FocusState` only works declared on a View, and the outline already has
    /// one.
    let focused: FocusState<NodeId?>.Binding
    let onOpen: (NodeId) -> Void
    let onBeginEdit: (Node) -> Void
    let onSubmit: () -> Void
    let onDelete: (NodeId) -> Void
    /// A project dragged to a new place in the list. Indices are into the
    /// unpinned projects — what this view draws — not into every root.
    let onMoveProject: (IndexSet, Int) -> Void
    /// A pin dragged to a new place on the shelf. Indices are into
    /// `pinnedItems`, which is the order the shelf is drawn in.
    let onMovePin: (IndexSet, Int) -> Void

    /// Whether the trash row was tapped. The trash view does not exist yet, so
    /// this only drives the "nothing to show you" note.
    let onOpenTrash: () -> Void

    /// The unpinned roots. Pinned ones move up to their own section rather than
    /// showing twice — the same rule the web's sidebar follows.
    private var projects: [Node] { TreeOps.projectSections(tree).unpinned }

    /// The shelf: pinned projects and pinned tasks in one hand-set order. A
    /// project is the entry with an empty trail.
    private var pins: [(node: Node, trail: [Node])] { TreeOps.pinnedItems(tree) }

    /// Collapse state, per device rather than per tree: which sections you keep
    /// shut is a preference about this phone's screen, not a fact about the
    /// projects, so it does not belong in the synced tree.
    @AppStorage("home.projectsOpen") private var projectsOpen = true
    @AppStorage("home.pinnedOpen") private var pinnedOpen = true

    /// Nothing pinned at all — neither a project nor a task. The section is
    /// hidden entirely then rather than shown empty, so a phone that has never
    /// pinned anything sees the list it used to see.
    private var nothingPinned: Bool { pins.isEmpty }

    /// Whether the shelf is showing everything it has. Per device and not
    /// persisted: expanding it is a thing you do to find one pin, not a setting
    /// about how you like the screen.
    @State private var showAllPins = false

    /// The row that is off the ground, from `ListLiftFeedback`, in the
    /// collection view's own terms. Only that row's card goes square — see
    /// `HomeCard`. A single flag squared every row at once, which reads as the
    /// corners simply never being rounded.
    @State private var lifted: IndexPath?

    /// Whether the lifted row is this one. The pinned section is 0 and projects
    /// is 1, matching the order they are declared in; the item index is the
    /// `ForEach` index, since a header is not an item.
    private func isLifted(section: Int, row: Int) -> Bool {
        lifted == IndexPath(item: row, section: section)
    }

    /// How many pins the shelf shows before it stops. A shelf is only a shelf
    /// while you can take it in at a glance — past that it is a second list,
    /// and the projects it sits above start falling off the screen.
    private let pinCap = 5

    private var pinCount: Int { pins.count }

    private var shownPins: [(node: Node, trail: [Node])] {
        showAllPins ? pins : Array(pins.prefix(pinCap))
    }

    /// How many rows the shelf's card is drawn over — the pins, and the "show
    /// all" button when there is one. It is what decides which row rounds its
    /// bottom corners.
    private var pinRowCount: Int {
        shownPins.count + (pinCount > pinCap && !showAllPins ? 1 : 0)
    }

    var body: some View {
        if projects.isEmpty && nothingPinned {
            if loaded {
                ContentUnavailableView(
                    "No projects yet",
                    systemImage: "tray",
                    // Names the control rather than a direction: the button
                    // sits in the corner, so "below" stopped being true when
                    // the field at the bottom went away.
                    description: Text("Tap + to start one."))
            } else {
                // Only reachable on a genuine cold start — with a cached tree
                // there are already projects to draw. Deliberately says nothing
                // about what is or is not there.
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        } else {
            List {
                // The shelf goes first now that it cannot grow past `pinCap`.
                // An uncapped one at the top would push the projects off the
                // screen; a short one is the reason you came to this screen.
                if !nothingPinned {
                    Section {
                        // Folded by hand rather than with `Section(isExpanded:)`,
                        // which only folds under `.sidebar` and `.insetGrouped` —
                        // and those are the styles that draw the card whose
                        // corners cannot be squared. Emitting no rows folds the
                        // section under any style.
                        if pinnedOpen {
                            // One `ForEach` over projects and tasks together: the
                            // shelf is arranged by hand, and a drag can only move
                            // a row within the list it is drawn in.
                            ForEach(Array(shownPins.enumerated()), id: \.element.node.id) { i, pin in
                                Group {
                                    if pin.trail.isEmpty {
                                        projectRow(pin.node)
                                    } else {
                                        PinnedTaskRow(
                                            node: pin.node,
                                            trail: pin.trail,
                                            progress: TreeOps.progressOf(tree, pin.node.id),
                                            onOpen: { onOpen(pin.node.id) })
                                    }
                                }
                                // Declared here for every row in the section, so
                                // the two kinds start at the same x. The card
                                // below is inset by the same gutter.
                                .listRowInsets(
                                    EdgeInsets(
                                        top: Space.inner, leading: Space.gutter,
                                        bottom: Space.inner, trailing: Space.gutter))
                                .modifier(
                                    HomeCard(
                                        slot: CardSlot.at(i, of: pinRowCount),
                                        lifted: isLifted(section: 0, row: i),
                                        separator: i < pinRowCount - 1))
                            }
                            // Only while the whole shelf is showing. A drag inside
                            // a capped list would renumber against positions the
                            // user cannot see.
                            .onMove(perform: showAllPins || pinCount <= pinCap ? onMovePin : nil)

                            // A row rather than an inner scroll view. Nesting one
                            // scroller inside the page's would make a single drag
                            // ambiguous about which list it moves, and hand off
                            // mid-gesture when the inner one hits its end.
                            if pinCount > pinCap && !showAllPins {
                                Button {
                                    // Explicit, because a bare state write here
                                    // pops five rows in on one frame and takes the
                                    // button out from under the finger in the same
                                    // one. The fold above animates itself; this is
                                    // a plain `@State` change and gets nothing
                                    // unless it asks.
                                    withAnimation(.easeOut(duration: 0.2)) {
                                        showAllPins = true
                                    }
                                } label: {
                                    Text("Show all \(pinCount)")
                                        .font(.subheadline)
                                        .foregroundStyle(.tint)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(.vertical, Space.row)
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .listRowInsets(
                                    EdgeInsets(
                                        top: Space.inner, leading: Space.gutter,
                                        bottom: Space.inner, trailing: Space.gutter))
                                .modifier(
                                    HomeCard(slot: .bottom, lifted: false, separator: false))
                            }
                        }
                    } header: {
                        SectionHeader(title: "Pinned", open: $pinnedOpen.animated)
                    }
                }

                Section {
                    if projectsOpen {
                        ForEach(Array(projects.enumerated()), id: \.element.id) { i, project in
                            projectRow(project)
                                .modifier(
                                    HomeCard(
                                        slot: CardSlot.at(i, of: projects.count),
                                        lifted: isLifted(section: 1, row: i),
                                        separator: i < projects.count - 1))
                        }
                        .onMove(perform: onMoveProject)
                    }
                } header: {
                    SectionHeader(title: "Projects", open: $projectsOpen.animated)
                }

                // Its own section with no header, so it reads as a place of its
                // own rather than the last project in the list.
                Section {
                    // `.plain` and an explicit shape, the same as a project row:
                    // the default button style in a sidebar list only takes a
                    // tap on the label's own glyph and text, so the rest of the
                    // row swallowed it.
                    Button(action: onOpenTrash) {
                        // Text first, can at the trailing edge — not a `Label`,
                        // which reserves an icon column ahead of the text and so
                        // started "Trash" well right of every project name. The
                        // rows share a left edge now; the can sits where a
                        // project's count does.
                        HStack(spacing: 6) {
                            Text("Trash")
                                .font(.body.weight(.medium))
                                .foregroundStyle(.secondary)
                            Spacer(minLength: 8)
                            Image(systemName: "trash")
                                .foregroundStyle(.secondary)
                        }
                        // One line where a project row has two, so the shared
                        // minimum is what gives this row its height.
                        .frame(minHeight: Space.tap, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    // The same insets as a project row, which every other row in
                    // this list already declares. Left out, this one kept the
                    // sidebar's defaults and started at a different x than the
                    // cards above it.
                    .listRowInsets(
                        EdgeInsets(
                            top: Space.inner, leading: Space.gutter,
                            bottom: Space.inner, trailing: Space.gutter))
                    // On a row, not on the `List`: the recognizer has to reach
                    // the collection view, and a `.background` on the list is
                    // hosted outside it — the walk up finds no scroll view and
                    // silently attaches nothing. This row is always here and
                    // there is only ever one of it.
                    //
                    // Before `HomeCard`, not after: the card sets a row
                    // background, and a `.background` applied after that is
                    // hosted outside the cell again.
                    .background(
                        ListLiftFeedback(onDragChanged: { lifted = $0 })
                            .frame(width: 0, height: 0))
                    .modifier(
                        HomeCard(
                            slot: .only, lifted: false, separator: false,
                            gapAbove: Space.block))
                }
            }
            .listStyle(.plain)
            // The grouped grey the cards sit on. `.sidebar` painted this; under
            // `.plain` the list's own background is the page's, so it has to be
            // said.
            .scrollContentBackground(.hidden)
            .background(Color(.systemGroupedBackground))
        }
    }

    /// One project row, with the handles that were on every card before the
    /// sections split them in two. Shared so a pinned project keeps them.
    private func projectRow(_ project: Node) -> some View {
        ProjectRow(
            project: project,
            progress: TreeOps.progressOf(tree, project.id),
            editing: editing == project.id,
            editText: $editText,
            focused: focused,
            onOpen: { onOpen(project.id) },
            onSubmit: onSubmit)
            // No context menu. Long-press is the reorder drag here, and a
            // menu on the same press wins it outright — the drag never starts.
            // Rename lives in the project's own `...`; delete is the swipe
            // below, which it already was.
            // The same insets as a pinned row. Without this the card took
            // the sidebar's defaults while the pinned row declared 16, so the
            // two sections started at different x — the most visible unearned
            // difference on the screen. Both are two-line rows; what should
            // separate them is the type, not the margin.
            .listRowInsets(
                EdgeInsets(
                    top: Space.inner, leading: Space.gutter,
                    bottom: Space.inner, trailing: Space.gutter))
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

/// A home-screen section header that folds its section.
///
/// The chevron and the tap are drawn here because `Section(isExpanded:)` only
/// folds under the list styles whose card this screen had to stop using.
private struct SectionHeader: View {
    let title: String
    @Binding var open: Bool

    var body: some View {
        Button {
            open.toggle()
        } label: {
            HStack {
                Text(title)
                Spacer()
                Image(systemName: "chevron.down")
                    // Rotated rather than swapped for `chevron.right`: a glyph
                    // swap cuts, and the turn is what says the section moved.
                    .rotationEffect(.degrees(open ? 0 : -90))
                    .font(.footnote.weight(.semibold))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .textCase(nil)
        .font(.subheadline.weight(.semibold))
        .listRowInsets(
            EdgeInsets(
                top: Space.block, leading: Space.gutter,
                bottom: Space.row, trailing: Space.gutter))
    }
}

/// Where a row sits in its section's card, which is what its corners round to.
private enum CardSlot {
    case only, top, middle, bottom

    var corners: UIRectCorner {
        switch self {
        case .only: return .allCorners
        case .top: return [.topLeft, .topRight]
        case .middle: return []
        case .bottom: return [.bottomLeft, .bottomRight]
        }
    }

    static func at(_ i: Int, of n: Int) -> CardSlot {
        if n <= 1 { return .only }
        if i == 0 { return .top }
        if i == n - 1 { return .bottom }
        return .middle
    }
}

/// The grouped card the home screen's rows sit on, drawn here rather than by
/// `.listStyle(.sidebar)`.
///
/// The system draws the same card, but its rounding is unreachable — every
/// layer on the cell reports a radius of 0 while the card is visibly round, so
/// it is drawn by a private path and cannot be squared for a row in flight.
/// That is the whole reason this exists: a row carrying the section's rounded
/// top corners into the middle of the list looks like it does not belong there.
private struct HomeCard: ViewModifier {
    let slot: CardSlot
    /// True while this row is off the ground. A lifted row is square whatever
    /// its slot: the rounding says "edge of the section", which stops being
    /// true the moment the row leaves its place.
    let lifted: Bool
    /// Whether a hairline goes under this row. Not on the last one, where it
    /// would draw across the card's bottom edge.
    let separator: Bool
    /// Blank space above the card, for a section that has no header to carry it.
    /// `.plain` puts nothing between sections of its own.
    var gapAbove: CGFloat = 0

    private var radius: CGFloat { 10 }

    func body(content: Content) -> some View {
        content
            .padding(.top, gapAbove)
            // The rows declare `Space.gutter` insets, which is the card's own
            // inset from the screen — so without this the text lands exactly on
            // the card's edge. This is the gutter *inside* the card.
            .padding(.horizontal, Space.gutter)
            .listRowSeparator(.hidden)
            .listRowBackground(
                ZStack(alignment: .bottom) {
                    RoundedCorners(
                        radius: radius,
                        corners: lifted ? [] : slot.corners
                    )
                    .fill(Color(.secondarySystemGroupedBackground))
                    // The gap is above the card, not inside it: the row is
                    // taller by `gapAbove`, and this keeps the fill off it.
                    .padding(.top, gapAbove)
                    if separator && !lifted {
                        Rectangle()
                            .fill(Color(.separator))
                            // A hairline, not a point: `.separator` at 1pt is a
                            // heavier line than the list's own.
                            .frame(height: 1 / UIScreen.main.scale)
                            // Indented to the text, the way a grouped list's is
                            // — the card already holds the outer gutter, so this
                            // is the row's own inner one.
                            .padding(.leading, Space.gutter)
                    }
                }
                .animation(.easeOut(duration: 0.12), value: lifted)
                // The card is inset from the screen; `.listRowInsets` only
                // insets the row's content, so without this the card runs edge
                // to edge and the grey page never shows beside it.
                //
                // The rows declare the same gutter, which puts their text this
                // far in again — inside the card rather than against its edge,
                // which is where a grouped row's text sits.
                .padding(.horizontal, Space.gutter)
            )
    }
}

/// A rectangle rounded on some corners and square on the others.
///
/// `RoundedRectangle` rounds all four, and `.cornerRadius(_:corners:)` does not
/// exist on a `Shape`, so the path is built by hand.
private struct RoundedCorners: Shape {
    let radius: CGFloat
    let corners: UIRectCorner

    func path(in rect: CGRect) -> Path {
        Path(
            UIBezierPath(
                roundedRect: rect,
                byRoundingCorners: corners,
                cornerRadii: CGSize(width: radius, height: radius)
            ).cgPath)
    }
}

/// A pinned task on the home screen: the thing to do, and the path that says
/// where it lives.
///
/// Not a `ProjectRow`. A project's row is a card with a progress bar because a
/// project is a body of work you are tracking; a checkpoint is a specific place
/// partway down one, and what it needs said about it is where it is.
private struct PinnedTaskRow: View {
    let node: Node
    let trail: [Node]
    let progress: TreeOps.Progress
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 6) {
                VStack(alignment: .leading, spacing: 1) {
                    // `.body`, the same as a project name: a pinned row and a
                    // project row sit in the same list, and a smaller name read
                    // as a lesser row rather than a different kind of one. The
                    // trail underneath is what says which is which.
                    Text(node.text.isEmpty ? "Untitled" : node.text)
                        .font(.body.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    // The project, not the whole trail. The name needs
                    // somewhere to live — "Total the receipts" says nothing
                    // alone — but the intermediate parents are how you would
                    // navigate there, and this row is the thing that means you
                    // do not have to.
                    //
                    // `.caption` is the smallest size on this screen — 11pt in
                    // `.secondary` was small and low-contrast at once, and hard
                    // to read for it. Against a 17pt name the colour is already
                    // enough to make this the lesser of the two.
                    //
                    // `.secondary`, not `.tertiary` — tertiary is 26% opacity,
                    // about 1.8:1 against the list.
                    Text(projectName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 8)

                // Only when it leads somewhere. A checkpoint with no children
                // is one task, and "0/0" says less than nothing about it.
                if progress.total > 0 {
                    Text("\(progress.done)/\(progress.total)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            // No padding of its own: the row insets carry it, the same ones
            // the project card uses, so both sections share a vertical rhythm
            // and differ only where they mean to. No pin glyph either — every
            // row here is pinned, so the marker said what the header said.
            .frame(minHeight: Space.tap, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// The root the pin hangs off. `trail` is root-first, so this is its head.
    private var projectName: String {
        guard let root = trail.first else { return "" }
        return root.text.isEmpty ? "Untitled" : root.text
    }
}

/// One project: its name, how far along it is, and a bar.
private struct ProjectRow: View {
    let project: Node
    let progress: TreeOps.Progress
    let editing: Bool
    @Binding var editText: String
    let focused: FocusState<NodeId?>.Binding
    let onOpen: () -> Void
    let onSubmit: () -> Void

    private var complete: Bool { progress.pct == 100 }

    @ViewBuilder var body: some View {
        // Only a Button when it is not being renamed. A TextField inside a
        // Button never sees the tap that would place the caret — the Button
        // swallows it and opens the project instead.
        if editing {
            card
        } else {
            Button(action: onOpen) { card }
                .buttonStyle(.plain)
        }
    }

    private var card: some View {
        // `inner`, not `row`: this is the gap between two halves of one
        // row, not the gap between rows. At 8 the card breathed differently
        // from the pinned row beside it.
        VStack(alignment: .leading, spacing: Space.inner) {
                HStack(spacing: 6) {
                    if project.pinned == true {
                        // Standing up, not lying over: this is not a button, so
                        // it says the state rather than what a tap would do.
                        PinIcon(size: 12)
                            .foregroundStyle(.tint)
                    }
                    if editing {
                        // Same weight and position as the label it replaces, so
                        // the card does not jump when the field appears.
                        TextField("Project name", text: $editText)
                            .textFieldStyle(.plain)
                            .font(.body.weight(.medium))
                            .focused(focused, equals: project.id)
                            .submitLabel(.done)
                            .onSubmit(onSubmit)
                    } else {
                        // Untitled is the web's word for a project with no name, and
                        // an empty row would otherwise look unopenable.
                        Text(project.text.isEmpty ? "Untitled" : project.text)
                            .font(.body.weight(.medium))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    Text(complete ? "All done" : "\(progress.done)/\(progress.total)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(
                            complete ? AnyShapeStyle(Color.done) : AnyShapeStyle(.secondary))
                }

                Capsule()
                    .fill(.quaternary)
                    .frame(height: 4)
                    .overlay(alignment: .leading) {
                        GeometryReader { geo in
                            Capsule()
                                .fill(complete ? Color.done : Color.accentColor)
                                .frame(width: geo.size.width * CGFloat(progress.pct) / 100)
                        }
                    }
            }
        // The three row kinds hold different things and so come out different
        // heights on content alone. A shared minimum levels them and gives each
        // one a full tap target; `maxHeight: .infinity` lets a row that needs
        // more still take it.
        .frame(minHeight: Space.tap, alignment: .leading)
        .contentShape(Rectangle())
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
