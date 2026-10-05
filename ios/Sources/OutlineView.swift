import AnsaCore
import AnsaSync
import SwiftUI

/// The outline, Workflowy-style: swipe a row right to zoom into that node, tap
/// its bullet to fold it, and Back walks out again.
///
/// The tree comes from `OutlineStore`, which applies each edit locally with the
/// same pure op the server will run and queues it for sending. Nothing in this
/// file touches the network or mutates the tree.
struct OutlineView: View {
    /// Whether there is a signed-in Clerk user behind this screen — true on the
    /// normal path, false on the `--no-auth` build, which runs with no Clerk in
    /// the environment at all. The home screen's account button reads
    /// `@Environment(Clerk.self)`, and reading a Clerk that was never put in the
    /// environment is a crash, not a nil — so the button only exists when this
    /// is true. Defaults to false so the keyless `OutlineView()` needs no change.
    var signedIn = false

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

    /// Whether the trash is the screen showing. A second axis beside `scope`
    /// rather than a case of it: every navigation helper here keys off a
    /// `NodeId?`, and the trash has no node to be. `scope` is left as it was, so
    /// back from the trash returns to the screen it was opened over.
    @State private var inTrash = false

    /// Whether Search is the screen showing. A third axis for the trash's
    /// reason: `scope` stays the place Search was opened from, which is where
    /// closing it returns and what Recently visited leaves out.
    @State private var inSearch = false
    /// What is typed in Search's field.
    @State private var query = ""
    @FocusState private var searchFocused: Bool
    /// Where Search's field is. Separate from focus because the grow starts
    /// before the field can take it, and the shrink runs after it has let go.
    @State private var searchSpot: SearchSpot = .tucked
    /// Search is closing onto a page that has just replaced the one under it:
    /// the new page's field shrinks when it appears.
    @State private var searchLeaving = false
    /// Where the list under Search was looking, for Back from a result.
    @State private var searchReturn: ScrollAnchor?
    /// The query, when the trash was opened from Search's trash line, so Back
    /// from the trash returns to Search rather than past it.
    @State private var trashOverSearch: String?
    /// The row a search result opened onto, lit brass for a moment so the
    /// eye lands on it among its siblings.
    @State private var arrival: NodeId?

    /// Whether Home's gear has Settings up.
    @State private var settingsShown = false

    /// The node the Move to box is choosing a place for, or nil when it is
    /// down.
    @State private var moving: NodeId?
    /// Whether Back's long-press has the path up.
    @State private var pathShown = false
    /// Set when a long-press on Back opens the path, so the Button's own action
    /// on the release that follows does not also go back.
    @State private var backHeld = false

    /// The scope being renamed, and the name being typed for it.
    ///
    /// Deliberately not `EditController`: that one is the row path's, keyed by
    /// the row whose `TextField` exists. The scope has no row — zooming in is
    /// what turns its row into the header — so its rename is a state of its
    /// own, and the two cannot overwrite each other.
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

    /// The focus value of `keyboardHolder`, a field that is never a row.
    private static let keyboardHolderId: NodeId = "\u{0}keyboard-holder"
    @State private var keyboardHolderText = ""
    /// Whether the holder capitalizes, copied from the field it takes over.
    @State private var keyboardHolderCaps = false
    /// The empty row waiting below the one being typed in, during a run.
    ///
    /// Return has to land on a field that already exists — building one and
    /// focusing it leaves a moment with nothing focused, and iOS takes the
    /// keyboard down for exactly that moment. Keeping a row one step ahead
    /// means the handover is a focus move between two live fields.
    ///
    /// The rows a run keeps mounted that are *not* in the tree: the one being
    /// typed into and the one waiting below it for Return to land on. Both are
    /// local to this view — no `addChild` is applied until a row is committed
    /// with text, so a blank never enters the synced tree and never shows on
    /// another device. `rows(of:)` splices these in; everything that maps a row
    /// id back to a tree node skips an id that `byId` cannot find.
    ///
    /// Ordered current-first, waiting-second. Empty outside a run.
    @State private var sentinels: [Node] = []

    /// Where each sentinel sits in the flattened list: the row id it follows and
    /// the depth to draw it at. The predecessor is a real tree row or the other
    /// sentinel, so the pair renders as two consecutive rows below the anchor.
    @State private var sentinelPlace: [NodeId: (after: NodeId?, depth: Int)] = [:]

    /// The real tree row each sentinel files under when it is committed, kept
    /// separately from the visual `after`. It has to be recorded at mint time:
    /// focusing the sentinel sets `edit.captureParent` to the sentinel's own id,
    /// which is not in the tree, so `commitSentinel` cannot recover the anchor
    /// from `captureParent` — `slot(below:)` on a nil lookup would file the row
    /// at the project root. nil means "no anchor, append to the project".
    @State private var sentinelAnchor: [NodeId: NodeId?] = [:]

    /// Where a sentinel will be filed, once indent or outdent has moved it.
    ///
    /// Absent until the depth buttons touch it; `sentinelAnchor` decides until
    /// then. A sentinel is not in the tree, so `indentOp` has nothing to move —
    /// the move is recorded here and lands with the row's first write, which
    /// keeps an empty row out of the synced tree even after it was indented.
    @State private var sentinelSlot: [NodeId: (parent: NodeId?, index: Int)] = [:]

    /// The sentinel the cursor is in — the first one, or nil outside a run.
    private var activeSentinel: NodeId? { sentinels.first?.id }

    /// Whether `id` is a mounted sentinel rather than a real tree node.
    private func isSentinel(_ id: NodeId) -> Bool {
        sentinels.contains { $0.id == id }
    }

    /// A sentinel that is not the one being typed into: the waiting row kept a
    /// step ahead of the cursor. It has to be in the list so Return can hand
    /// focus to a built field, but it must show nothing — so the row is
    /// collapsed to zero height and made deaf. See `addRow`.
    private func isWaitingSentinel(_ id: NodeId) -> Bool {
        isSentinel(id) && id != activeSentinel
    }
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme

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
            //
            // Identified by the screen they show, not by their place in the
            // stack. When a back swipe lands, the copy behind is already the
            // screen being landed on, fully drawn — keyed this way it *becomes*
            // the live slab rather than being thrown away while the live one
            // rebuilds the same rows from nothing, which drew a frame of
            // half-filled list: a flicker with nothing moving.
            ZStack {
                // Above the slabs, not in one: a slab is keyed by its screen,
                // so one in a slab leaves with that screen — and opening a
                // just-named project is a screen change with the keyboard up.
                if edit.isEditing || focusedRow != nil { keyboardHolder }
                ForEach(slabLayers, id: \.key) { layer in
                    slab(for: layer.scope, interactive: layer.live,
                         trash: layer.trash, search: layer.search,
                         restoring: layer.restoring, homeBack: layer.homeBack)
                    // Over the revealed screen, under the one being lifted
                    // off it.
                    if !layer.live { backdrop }
                }
            }
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
            // The keyboard going down drops the field to the pill's line, and
            // coming back up lifts it. Not while tucked: that is the grow and
            // the shrink, which move it themselves.
            .onChange(of: searchFocused) { _, focused in
                guard inSearch, !searchLeaving, searchSpot != .tucked else { return }
                withAnimation(.easeOut(duration: 0.25)) { searchSpot = focused ? .up : .low }
            }
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .active: store.resume()
                case .background:
                    // End any open session before suspending. The waiting rows
                    // are local sentinels that never touch the tree, so nothing
                    // blank would sync — but a typed row should commit rather
                    // than be lost when the app leaves the foreground.
                    if edit.isEditing { stopAdding() }
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

            pathOverlay
            moveOverlay
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
            // No *navigation* `.toolbar`. That bar belongs to the
            // `NavigationStack` and renders outside this view, so `backPull`'s
            // offset moved the whole screen except its header. The header is
            // drawn inside the slab.
            //
            // `.keyboard` placement is a different surface — it rides the
            // keyboard's own accessory view, not the nav bar, so the offset
            // problem above does not apply. It also means the bar exists
            // exactly when a field is focused, which is the behaviour we
            // wanted: Obsidian's bar appears with the keyboard and leaves with
            // it, rather than sitting on screen permanently.
            .navigationBarHidden(true)
            .sheet(isPresented: $settingsShown) { SettingsView() }
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

    /// Rename, pin, move and delete, aimed at the scope itself.
    ///
    /// Ellipsis rather than a named glyph: the actions have nothing in
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

                // Its own box rather than a submenu: the menu closes and the
                // places come up in the middle of the screen. Hidden when
                // there is nowhere to go — a lone project.
                if !moveTargets(for: node).isEmpty || node.parentId != nil {
                    Button("Move to…", systemImage: "folder") { showMove(id) }
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
                    // The glyph is ~20x8pt of ink, and without a frame that ink
                    // is the whole hit target — the band's own `minHeight: 44`
                    // sizes the band, not what sits in it. `contentShape` is the
                    // half that matters: the frame alone lays out the space but
                    // still only the glyph takes the tap. Matches the back
                    // button opposite. Ink on the page's gutter, in line with
                    // the progress bar, the rest of the 44pt target reaching
                    // inward.
                    .padding(.trailing, Space.gutter)
                    .frame(width: 44, height: 44, alignment: .trailing)
                    .contentShape(Rectangle())
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
    ///
    /// `veiled` is Search up over the page: the words go soft and pale, the
    /// band stays, so the header still says where closing Search goes.
    @ViewBuilder private func header(
        for scope: NodeId?, interactive: Bool, trash: Bool, veiled: Bool = false
    ) -> some View {
        // No band with no scope: that is Home, which draws its own top row.
        if trash || scope != nil {
            HStack(spacing: Space.row) {
                backButton(for: scope, interactive: interactive, trash: trash)

                Spacer(minLength: 0)

                // The destination, not the route. The path is on Back's
                // long-press instead, so the title is only a name.
                if trash {
                    // A plain name. `ScopeTitle` carries the rename field and
                    // the drop target, and the trash has neither.
                    Text("Trash").font(.headline)
                } else {
                    ScopeTitle(
                        title: title(of: scope),
                        // Only the live copy can be a drop target; a drag and a
                        // back swipe cannot both be running.
                        lit: interactive && litRoot,
                        editing: interactive && renamingScope != nil && renamingScope == scope,
                        editText: $renameText,
                        typing: $renamingFocus,
                        onCommit: commitScopeRename)
                }

                Spacer(minLength: 0)

                // Balances Back opposite so the title stays centred.
                if trash {
                    Image(systemName: "ellipsis").opacity(0)
                } else {
                    scopeMenu.disabled(!interactive)
                }
            }
            .veiled(veiled)
            // No fixed height. The buttons carry their own 44pt hit target, so
            // the band lands in the same place the system bar did without a
            // number that a larger Dynamic Type setting would then be squeezed
            // into. `minHeight` here sizes the band only — it does nothing for
            // what sits in it, which is how the `...` and the back chevron went
            // a long time being tappable only on their ink.
            .frame(minHeight: 44)
            // The material the bar had, not a flat fill. Rows scrolling up
            // under the header blur through it instead of vanishing at a hard
            // edge, which is the one thing that gave away that this is a view
            // in the page rather than the bar it replaced.
            .background(.bar)
        }
    }

    /// Back, with the path above this scope on a long-press.
    ///
    /// Always live: at a project's top level it goes to Home.
    ///
    /// The path used to hang off the title as a menu. It moved here because it
    /// is a list of places back could go, and because a title that is a button
    /// cannot also be only a name.
    @ViewBuilder private func backButton(for scope: NodeId?, interactive: Bool, trash: Bool)
        -> some View
    {
        // Root first, and without the scope itself, which is where you already
        // are. Empty in the trash: its path is the scope underneath, and one
        // tap of Back already goes there.
        let ancestors = trash ? [] : scope.map { Array(TreeOps.lineageOf(tree, $0).dropLast()) } ?? []
        let enabled = interactive && (trash || scope != nil)
        let glyph = Image(systemName: "chevron.left")
            // Same 44pt target as the `...` opposite, for the same reason: a
            // bare glyph is only as tappable as its ink. Ink on the gutter; the
            // target extends inward.
            .padding(.leading, Space.gutter)
            .frame(width: 44, height: 44, alignment: .leading)
            .contentShape(Rectangle())
        Button {
            if backHeld { backHeld = false; return }
            if interactive { zoomOut() }
        } label: { glyph }
        // A long-press opening `pathOverlay`, not `.contextMenu`, which lifts
        // and enlarges the button over the progress bar while the menu is up
        // and gives no say over row height. `Menu(primaryAction:)` avoided the
        // lift but dropped the tap.
        .simultaneousGesture(
            LongPressGesture(minimumDuration: 0.4).onEnded { _ in
                guard interactive, !ancestors.isEmpty else { return }
                backHeld = true
                showPath()
            })
        .disabled(!enabled)
        .accessibilityLabel("Back")
    }

    /// The path above this scope, outermost first, as 44pt rows, hung under
    /// Back while its long-press has it up.
    ///
    /// Drawn here rather than as a `.popover`: iOS 26 draws popovers as glass
    /// with its own large corner radius, and `presentationCornerRadius` does
    /// not reach them.
    @ViewBuilder private var pathOverlay: some View {
        // The ZStack stays and its children come and go, so each one gets its
        // own transition. Behind a single `if` around the whole thing, only
        // the outer view's transition would run.
        ZStack(alignment: .topLeading) {
            if pathShown, !inTrash, let scope {
                let ancestors = Array(TreeOps.lineageOf(tree, scope).dropLast())
                // A tap anywhere else closes it without doing anything else.
                Color.clear
                    .contentShape(Rectangle())
                    .ignoresSafeArea()
                    .onTapGesture { hidePath() }

                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(ancestors.enumerated()), id: \.element.id) { i, node in
                        if i > 0 { Divider() }
                        Button {
                            hidePath()
                            setScope(node.id)
                        } label: {
                            Text(node.text.isEmpty ? "Untitled" : node.text)
                                .lineLimit(1)
                                .padding(.horizontal, Space.gutter)
                                .frame(maxWidth: .infinity, minHeight: Space.tap,
                                       alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .frame(minWidth: 180, maxWidth: 280, alignment: .leading)
                .fixedSize()
                .modifier(PathBoxSurface())
                // Grows out of the chevron above it and shrinks back into it.
                .transition(.scale(scale: 0.4, anchor: .topLeading)
                    .combined(with: .opacity))
                // Under the header band, its left edge on the gutter under
                // the chevron.
                .padding(.top, 44)
                .padding(.leading, Space.row)
            }
        }
    }

    private func showPath() {
        withAnimation(.spring(duration: 0.3, bounce: 0.2)) { pathShown = true }
    }

    private func hidePath() {
        // The release after the long-press doesn't always reach the Button, and
        // a `backHeld` left set swallows the next real tap on Back.
        backHeld = false
        withAnimation(.easeOut(duration: 0.18)) { pathShown = false }
    }

    /// The projects a node can move into, in Home's order: pinned
    /// projects first, then the rest. Leaves out the node itself, and the
    /// project it already sits at the top of, where the move would change
    /// nothing.
    private func moveTargets(for node: Node) -> [Node] {
        let pinned = TreeOps.pinnedItems(tree).filter { $0.trail.isEmpty }.map(\.node)
        let rest = TreeOps.projectSections(tree).unpinned
        return (pinned + rest).filter { $0.id != node.id && $0.id != node.parentId }
    }

    /// Where the ⋯ menu's Move to lands: New Project, then every project it
    /// could go into. Either one drops it at the bottom of that level, and you
    /// stay on whatever you were looking at.
    ///
    /// New Project is the old Convert to Project, and only for a task — a
    /// project already is one. Picking a project for a project makes it a task
    /// there, the way back from New Project.
    @ViewBuilder private var moveOverlay: some View {
        GeometryReader { geo in
            ZStack {
                if let id = moving, let node = TreeOps.byId(tree, id) {
                    let targets = moveTargets(for: node)
                    let canConvert = node.parentId != nil
                    Color.black.opacity(0.15)
                        .contentShape(Rectangle())
                        .ignoresSafeArea()
                        .onTapGesture { hideMove() }
                        .transition(.opacity)

                    VStack(spacing: 0) {
                        if canConvert {
                            moveRow("New Project", systemImage: "plus") {
                                move(id, into: nil)
                            }
                            if !targets.isEmpty { Divider() }
                        }
                        // Sized to its rows up to 60% of the screen, then
                        // scrolls. A ScrollView takes all the height it is
                        // offered, so the cap is set by hand.
                        ScrollView {
                            VStack(spacing: 0) {
                                ForEach(Array(targets.enumerated()), id: \.element.id) { i, project in
                                    if i > 0 { Divider() }
                                    moveRow(project.text.isEmpty ? "Untitled" : project.text) {
                                        move(id, into: project.id)
                                    }
                                }
                            }
                        }
                        .scrollBounceBehavior(.basedOnSize)
                        .frame(height: min(CGFloat(targets.count) * (Space.tap + 1),
                                           geo.size.height * 0.6))
                    }
                    .frame(width: min(280, geo.size.width - 2 * Space.gutter))
                    .modifier(PathBoxSurface())
                    .transition(.scale(scale: 0.85).combined(with: .opacity))
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
    }

    private func moveRow(
        _ title: String, systemImage: String? = nil, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: Space.block) {
                if let systemImage { Image(systemName: systemImage) }
                Text(title).lineLimit(1)
            }
            .padding(.horizontal, Space.gutter)
            .frame(maxWidth: .infinity, minHeight: Space.tap, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func showMove(_ id: NodeId) {
        withAnimation(.spring(duration: 0.3, bounce: 0.2)) { moving = id }
    }

    private func hideMove() {
        withAnimation(.easeOut(duration: 0.18)) { moving = nil }
    }

    /// To the bottom of `parent`'s top level, or of the project list for nil.
    private func move(_ id: NodeId, into parent: NodeId?) {
        hideMove()
        apply(.moveNode(
            id: id, parentId: parent,
            index: TreeOps.childrenOf(tree, parent).count))
        // The path above it changed, so the trail back no longer leads
        // anywhere it came from.
        backTrail.removeAll()
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
    /// - Parameter search: the query, when this screen is Search.
    @ViewBuilder private func slab(
        for scope: NodeId?, interactive: Bool, trash: Bool, search: String? = nil,
        restoring: ScrollAnchor? = nil, homeBack: Bool = false
    ) -> some View {
            // Search is up and grown, not just tucked in the pill on its way
            // in or out. What the header's veil and the frost follow.
            let veiled = search != nil && (!interactive || searchSpot != .tucked)
            VStack(spacing: 0) {
                // Under Search the header stays, veiled, and is one target
                // that closes it: it is the page you go back to.
                Group {
                    if home(scope, trash: trash) {
                        homeTopRow(
                            interactive: interactive && search == nil, back: homeBack,
                            veiled: veiled)
                    } else {
                        header(
                            for: scope, interactive: interactive && search == nil,
                            trash: trash, veiled: veiled)
                    }
                }
                .overlay {
                    if search != nil {
                        Color.clear
                            .contentShape(Rectangle())
                            .highPriorityGesture(
                                TapGesture().onEnded { zoomOut() },
                                including: interactive ? .all : .none)
                            .accessibilityLabel("Close search")
                            .accessibilityAddTraits(.isButton)
                    }
                }

                if !store.live {
                    // Only about receiving. Saying "not saved" here would be a
                    // lie that pushes people into re-typing work that is
                    // already queued and will go out on its own.
                    SyncBanner(
                        text:
                            "Not receiving changes from other devices. Your edits are still saved."
                    )
                }

                // Outranks the offline banner: that one says edits are still
                // being saved, which is true of deafness and a lie here.
                if let why = store.rejectedReason {
                    SyncBanner(
                        icon: "exclamationmark.triangle",
                        text: why,
                        onDismiss: { store.clearRejected() }
                    )
                }

                // The page, inert under Search but still drawn where it was, so
                // closing Search is the page coming back rather than rebuilt.
                let pageLive = interactive && search == nil
                VStack(spacing: 0) {
                    if trash {
                        // `interactive` too: the copy drawn behind the swipe must
                        // not take the gesture either, the same as an outline's.
                        TrashView(
                            store: store, backing: interactive && backPull > 0,
                            query: trashOverSearch)
                    } else if scope == nil {
                        homePage(interactive: pageLive)
                    } else {
                        // Under the bar, above the list: the figure the title used
                        // to carry as a caption. Only here — the grid and the trash
                        // have no scope to be a fraction of.
                        ScopeProgress(progress: TreeOps.scopeProgress(tree, scope))
                        outline(for: scope, interactive: pageLive,
                                restoring: restoring)
                    }
                }
                .overlay {
                    if let search {
                        searchLayer(
                            query: search, scope: scope, trash: trash,
                            interactive: interactive, shown: veiled)
                    }
                }
            }
        // Over the list rather than below it, so it costs no height — and as a
        // safe-area inset rather than an overlay, because the inset is what
        // rises with the keyboard. Sitting still while the keyboard came up
        // would put the button under it at exactly the moment it becomes the
        // way out.
        //
        // On Home the plus makes a project; everywhere else, a task.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            // Both riders in one strip: the depth buttons on the left, the
            // capture button on the right, sharing the inset that rises with
            // the keyboard.
            //
            // Not `ToolbarItemGroup(placement: .keyboard)`, which the design
            // named. It renders nothing here — a bare `TextField` with one in
            // a stock `NavigationStack`, built in this project, showed no bar
            // either, so it is not something in this view suppressing it. The
            // inset was already carrying the plus for the same reason the bar
            // needs, and it draws.
            if let search {
                searchBar(query: search, interactive: interactive)
            } else {
            HStack(spacing: 0) {
                if edit.isEditing {
                    // Not for a project's name on Home: indenting would file
                    // one project inside the one above it.
                    if !home(scope, trash: trash) { depthButtons(interactive: interactive) }
                } else {
                    navPill(onHome: home(scope, trash: trash), interactive: interactive)
                }
                Spacer(minLength: 0)
                // One slot, two occupants, never both: Done while a field is
                // open, the plus otherwise. The plus does not move or hide —
                // it keeps its corner and the keyboard covers it, so what
                // stands here during a session is the way out rather than a
                // second way in.
                //
                // Not in the trash, where there is nothing to add to.
                //
                // Not on Home either, where the open field is a project's name
                // and the keyboard's own ✓ already confirms it — and goes in.
                // A second ✓ that only saved and stayed put looked the same
                // and did less.
                if edit.isEditing {
                    if !home(scope, trash: trash) { doneButton(interactive: interactive) }
                } else if !trash {
                    captureButton(interactive: interactive, home: scope == nil)
                }
            }
            // Room above the buttons while a field is open. The keyboard
            // scrolls a tapped row only until it clears this inset, which left
            // a low row's text touching the depth buttons. Empty space, so it
            // takes no taps from the rows under it.
            .padding(.top, edit.isEditing ? Space.gutter : 0)
            }
        }
        // While Search is up the pill and the + stay where they were rather
        // than riding the keys, so the keys slide over them. With the keyboard
        // down, Search's own Home takes the pill's corner.
        //
        // On a layer the size of the page that ignores the keyboard: on the
        // button alone, `ignoresSafeArea` left it riding up with the keys.
        .overlay {
            if search != nil {
                Color.clear
                    .overlay(alignment: .bottom) {
                        if interactive && searchSpot != .low {
                            HStack(spacing: 0) {
                                navPill(
                                    onHome: home(scope, trash: trash), interactive: false,
                                    searchHidden: true)
                                Spacer(minLength: 0)
                                if !trash { captureButton(interactive: false, home: scope == nil) }
                            }
                        } else {
                            HStack(spacing: 0) {
                                searchHome(interactive: interactive)
                                Spacer(minLength: 0)
                            }
                        }
                    }
                    .ignoresSafeArea(.keyboard)
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
                    onBeginEdit: { beginEdit(row.node) },
                    onBlur: { id in commitEdit(from: id, releasingFocus: false) },
                    // Return commits this row and opens the next. One meaning,
                    // always — there is no longer an adding mode for it to
                    // branch on.
                    //
                    // It is not also the way out. Committing an *empty* row is,
                    // and `submitAdding` ends the session on one because there
                    // is nothing to file. So pressing Return on the blank it
                    // just opened puts the keyboard down, without Return itself
                    // having to check anything.
                    onSubmit: { submitAdding() },
                    onBackspaceEmpty: { removeEmptied(row.node.id) },
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
                    // Zero for the waiting sentinel: the padding is the cell's
                    // own height, so leaving it in keeps a gap where the hidden
                    // row sits even with its content zeroed.
                    .padding(.vertical, isWaitingSentinel(row.node.id) ? 0 : OutlineRow.rowPadding / 2)
                    .background {
                        RoundedRectangle(cornerRadius: 10)
                            .fill(FoundPalette.mark)
                            .padding(.horizontal, Space.row)
                            .opacity(interactive && arrival == row.node.id ? 1 : 0)
                    }
                    .listRowInsets(EdgeInsets())
                    // The waiting sentinel is present only so Return has a built
                    // field to land on. It shows nothing and takes no space: the
                    // field still exists and can hold focus, but the row is
                    // collapsed to nothing and deaf to touches.
                    .frame(height: isWaitingSentinel(row.node.id) ? 0 : nil)
                    .opacity(isWaitingSentinel(row.node.id) ? 0 : 1)
                    .allowsHitTesting(!isWaitingSentinel(row.node.id))
                    .clipped()
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

    /// The one control: a plus, always, that starts an editing session.
    ///
    /// It does not move or hide when the keyboard comes up — it sits behind it.
    /// Riding the bottom safe-area inset is what used to lift it clear; the
    /// inset now holds the depth bar, and the button keeps its corner.
    ///
    /// Inert behind a swipe for the same reason as a row's field — the copy
    /// underneath must not act on a screen that is sliding away.
    ///
    /// On Home it makes a project instead of a task.
    @ViewBuilder private func captureButton(interactive: Bool, home: Bool) -> some View {
        // Not a `Button`. A Button installs its own tap recogniser, and the
        // zoom-out back swipe — a `minimumDistance: 0` drag on the whole
        // navigation stack — is recognised simultaneously with it and could win
        // the tap, so the press did nothing. Device-only: the simulator's
        // synthesised touches never make the two recognisers contend. A plain
        // label with a high-priority tap claims the touch ahead of that drag.
        Group {
            // One glyph, because the button has one job: open a row. Return
            // continues a session and Done ends one, so nothing here has to
            // offer a way out — and a plus that stays a plus is a plus you can
            // press twice without reading it.
            //
            // It used to change: a tick while adding, a keyboard-down while
            // renaming. Both existed to give a press that *ended* something,
            // which was only needed while Return meant "another row". The tick
            // also had to dodge Return's own `.done` tick a thumb's width away
            // (`4a79bbb`) — a collision that now applies in every state, which
            // is the second reason not to draw one.
            //
            // Quiet, matching the back and home buttons. A filled accent circle
            // on a corner control pressed once per task was the loudest thing
            // on a screen that is mostly text.
            Image(systemName: "plus")
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
                .frame(width: 56, height: 56)
                .modifier(CaptureButtonSurface())
                // Deliberately no `.id(...)` and no transition. Either one
                // would make a changed glyph a separate view, so SwiftUI would
                // remove one and insert the other — a second way to get two
                // buttons on screen at once.
        }
        .contentShape(Circle())
        .highPriorityGesture(
            TapGesture().onEnded { home ? addProject() : capture() },
            including: interactive ? .all : .none)
        // `Space.corner` from both edges, stated once. This rides a `safeAreaInset`, so
        // the bottom padding stacks on whatever the system reserves for the
        // home indicator: the same number on both sides sat it ~50 from the
        // bottom and 16 from the right. Subtracting the strip on one side and
        // adding it on the other is what makes the two distances equal on a
        // phone that has one and on a phone that does not.
        //
        // Not clamped at 0: the corner is less than the ~34pt strip, so the
        // padding goes negative and the disc dips into the strip. That is
        // the point — clamping held it at 34 from the bottom and 24 from the
        // side, which is the unequal pair this exists to prevent.
        .padding(.bottom, Space.corner - homeIndicator)
        .padding(.trailing, Space.corner)
        .accessibilityLabel(home ? "New project" : "Add a task")
    }


    /// Home and Search, in one glass capsule in the capture button's opposite
    /// corner: the same height and the same distance from the edges, so the
    /// two read as a pair.
    ///
    /// Home is lit on Home. Neither half is lit on an outline page, which is
    /// somewhere you went from one of them rather than one of them.
    ///
    /// `searchHidden` is the pill under Search, whose Search half has grown
    /// into the field and is drawn by it.
    @ViewBuilder private func navPill(
        onHome: Bool, interactive: Bool, searchHidden: Bool = false
    ) -> some View {
        HStack(spacing: Space.tight) {
            pillTab(
                onHome ? "house.fill" : "house", label: "Home", lit: onHome,
                interactive: interactive, action: goHome)
            // Never lit: Search replaces the pill while it is showing.
            pillTab(
                "magnifyingglass", label: "Search", lit: false,
                interactive: interactive, action: openSearch)
                .opacity(searchHidden ? 0 : 1)
        }
        .padding(Space.tight)
        .modifier(PillSurface())
        .padding(.bottom, Space.corner - homeIndicator)
        .padding(.leading, Space.corner)
    }

    /// Search's field, in the pill's place at the bottom.
    ///
    /// It opens as exactly the pill's Search half and grows from there to the
    /// full width just above the keys; closing runs that backwards. With the
    /// keyboard down it drops to the pill's line and slots in beside
    /// `searchHome`, which never moves — so the way home is where the pill's
    /// Home was, and the field stays one tap from typing again.
    @ViewBuilder private func searchBar(query shown: String, interactive: Bool) -> some View {
        let spot = interactive ? searchSpot : .low
        // The pill's Search half: past the pill's rim, Home's half and the gap
        // between them.
        let tab = Space.corner + Space.tight + pillTabWidth + Space.tight
        // Keyboard up: the gutter, clear of the keys. Down: the corner the
        // plus keeps on the right, and Home's width and a gap on the left.
        let leading: CGFloat = switch spot {
            case .tucked: tab
            case .up: Space.gutter
            case .low: Space.corner + searchHomeSize + 10
        }
        let bottom: CGFloat = switch spot {
            case .tucked: Space.corner - homeIndicator + Space.tight
            case .up: Space.row
            case .low: Space.corner - homeIndicator
        }
        searchField(query: shown, spot: spot, interactive: interactive)
            .frame(maxWidth: spot == .tucked ? pillTabWidth : .infinity)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, leading)
            .padding(.trailing, spot == .up ? Space.gutter : Space.corner)
            .padding(.bottom, bottom)
            .onAppear {
                guard interactive else { return }
                // Going Home from Search: drawn grown over the new page first,
                // so there is somewhere to shrink from.
                if searchLeaving {
                    searchLeaving = false
                    closeSearch()
                    return
                }
                // Drawn tucked first, so there is somewhere to grow from.
                guard searchSpot == .tucked else { return }
                withAnimation(searchMotion) { searchSpot = .up }
            }
    }

    /// The grow and the shrink. A guess at the keyboard's own curve, to be
    /// judged on the phone.
    private let searchMotion = Animation.timingCurve(0.25, 0.9, 0.3, 1, duration: Self.searchGrow)
    private static let searchGrow: TimeInterval = 0.3

    /// Heavy frost over the page and Search's list on it, below the header.
    ///
    /// The frost is what makes the results read the same whatever is under
    /// them. On Home its top edge fades, since the account row has no bar
    /// for it to stop at.
    private func searchLayer(
        query: String, scope: NodeId?, trash: Bool, interactive: Bool, shown: Bool
    ) -> some View {
        let soft = home(scope, trash: trash)
        return ZStack {
            Rectangle()
                .fill(.thickMaterial)
                .mask {
                    VStack(spacing: 0) {
                        LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom)
                            .frame(height: soft ? 28 : 0)
                        Color.black
                    }
                }
                .ignoresSafeArea(edges: .bottom)
            SearchPage(
                tree: tree, store: store, query: query, from: trash ? nil : scope,
                onOpen: { if interactive { openFromSearch($0) } },
                onFind: { if interactive { openFromSearch($0, arriving: true) } },
                onOpenTrash: { if interactive { openTrashFromSearch() } },
                onTapAway: { if interactive { searchFocused = false } },
                onTapBare: { if interactive { zoomOut() } })
        }
        .opacity(shown ? 1 : 0)
        .allowsHitTesting(shown)
    }

    private let searchHomeSize: CGFloat = 56
    /// One half of the pill. Search's field starts and ends at this width.
    private let pillTabWidth: CGFloat = 64

    /// Search's Home, in the pill's corner. Pinned to the page rather than
    /// riding the keyboard like the field: the keys cover it while they are
    /// up, and going down they uncover it where it always was. Nothing about
    /// it moves, fades or grows.
    private func searchHome(interactive: Bool) -> some View {
        Image(systemName: "house")
            .font(.system(size: 20, weight: .medium))
            .foregroundStyle(Color.primary)
            .frame(width: searchHomeSize, height: searchHomeSize)
            .modifier(CaptureButtonSurface())
            .contentShape(Circle())
            .highPriorityGesture(
                TapGesture().onEnded(goHome), including: interactive ? .all : .none)
            .accessibilityLabel("Home")
            .accessibilityAddTraits(.isButton)
            .padding(.leading, Space.corner)
            .padding(.bottom, Space.corner - homeIndicator)
    }

    /// The field itself: a glass capsule with the one ✕.
    ///
    /// The ✕ clears the text, and on an empty field closes Search. With the
    /// keyboard down and nothing typed it has nothing to clear and Home is
    /// beside it, so it goes.
    ///
    /// Tucked, it is drawn as the pill's Search half: the pill's glass, the
    /// pill's magnifying glass, and no text. The words and the ✕ come in over
    /// the second half of the grow and go over the first half of the shrink,
    /// so they never squeeze through the narrow field.
    @ViewBuilder private func searchField(query shown: String, spot: SearchSpot, interactive: Bool)
        -> some View
    {
        let tucked = spot == .tucked
        let clearable = !shown.isEmpty || spot == .up
        let half = Self.searchGrow / 2
        let words = Animation.linear(duration: half).delay(tucked ? 0 : half)
        let height: CGFloat = switch spot {
            case .tucked: 52
            case .up: 48
            case .low: searchHomeSize
        }
        HStack(spacing: 0) {
            HStack(spacing: Space.row) {
                // The pill's glyph when tucked, the field's when grown.
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(tucked ? Color(.label) : Color(.secondaryLabel))
                    .scaleEffect(tucked ? 21 / 17 : 1)
                // Only the live copy is a field. Two fields on one focus
                // binding would each claim the keyboard; the copy behind a
                // swipe just shows what was typed.
                Group {
                    if interactive {
                        TextField("Search", text: $query)
                            .focused($searchFocused)
                            .submitLabel(.search)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                    } else {
                        Text(shown.isEmpty ? "Search" : shown)
                            .foregroundStyle(shown.isEmpty ? .secondary : .primary)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .animation(words) { $0.opacity(tucked ? 0 : 1) }
            }
            // Tucked, the glyph sits centred in the pill's half, as the
            // pill's own does.
            .padding(.leading, tucked ? (pillTabWidth - 20) / 2 : 14)
            .frame(maxHeight: .infinity)
            // All of it opens the keyboard, not just the text's width. Not
            // the ✕, whose clear should leave the keyboard where it was.
            .contentShape(Rectangle())
            .simultaneousGesture(
                TapGesture().onEnded { searchFocused = true },
                including: interactive && !tucked ? .all : .none)
            Image(systemName: "xmark.circle.fill")
                .foregroundStyle(.secondary)
                // No width tucked, or it would push the glyph off centre.
                .frame(width: tucked ? 0 : 36, height: 44)
                .contentShape(Rectangle())
                .highPriorityGesture(
                    TapGesture().onEnded {
                        if query.isEmpty { zoomOut() } else { query = "" }
                    },
                    including: interactive && clearable && !tucked ? .all : .none)
                .animation(words) { $0.opacity(clearable && !tucked ? 1 : 0) }
                .accessibilityLabel(shown.isEmpty ? "Close search" : "Clear")
                .accessibilityHidden(!clearable)
        }
        .padding(.trailing, tucked ? 0 : Space.inner)
        .frame(height: height)
        .modifier(PillSurface(shown: !tucked))
    }

    /// One half of the pill. A high-priority tap rather than a `Button`, for
    /// the capture button's reason: the back swipe's `minimumDistance: 0` drag
    /// can win a Button's tap on a device.
    private func pillTab(
        _ systemImage: String, label: String, lit: Bool, interactive: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Image(systemName: systemImage)
            .font(.system(size: 21, weight: .medium))
            .foregroundStyle(lit ? Color.accentColor : Color.primary)
            // 52 tall so the pill, with its 2pt rim, is the + disc's 56.
            .frame(width: pillTabWidth, height: 52)
            .background(Capsule().fill(Color(.tertiarySystemFill)).opacity(lit ? 1 : 0))
            .contentShape(Capsule())
            .highPriorityGesture(
                TapGesture().onEnded(action), including: interactive ? .all : .none)
            .accessibilityLabel(label)
            .accessibilityAddTraits(lit ? [.isButton, .isSelected] : .isButton)
    }

    /// Whether this screen is Home: no scope, and not the trash.
    private func home(_ scope: NodeId?, trash: Bool) -> Bool { scope == nil && !trash }

    /// Home's header: the account and the gear, and Back when you came from
    /// somewhere. Apart from the lists so Search can draw below it, the same
    /// as a project's header.
    private func homeTopRow(interactive: Bool, back: Bool, veiled: Bool) -> some View {
        HStack(spacing: Space.row) {
            // Back to where you were, when you came from somewhere. A
            // high-priority tap for the pill's reason.
            if back {
                // The project header's chevron: body size, ink on the gutter.
                Image(systemName: "chevron.left")
                    .foregroundStyle(.tint)
                    .frame(width: 44, height: 44, alignment: .leading)
                    .contentShape(Rectangle())
                    .highPriorityGesture(
                        TapGesture().onEnded { zoomOut() },
                        including: interactive ? .all : .none)
                    .accessibilityLabel("Back")
                    .accessibilityAddTraits(.isButton)
            }
            // Only signed in: the keyless build has no Clerk to read, and
            // reading one is a crash.
            if signedIn { AccountRow() }
            Spacer(minLength: 0)
            Image(systemName: "gearshape")
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(.tint)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
                .highPriorityGesture(
                    TapGesture().onEnded { settingsShown = true },
                    including: interactive ? .all : .none)
                .accessibilityLabel("Settings")
                .accessibilityAddTraits(.isButton)
        }
        .veiled(veiled)
        .padding(.leading, Space.gutter)
        .padding(.trailing, Space.row)
        .frame(minHeight: 52)
        .background(Color(.systemGroupedBackground).ignoresSafeArea(edges: .top))
    }

    /// The pinned and project lists at full width.
    private func homePage(interactive: Bool) -> some View {
        ProjectGrid(
            tree: tree, loaded: store.loaded,
            editing: interactive ? edit.editing : nil, editText: $edit.text,
            focused: $focusedRow,
            onOpen: { if interactive { openProject($0) } },
            onBeginEdit: beginEdit,
            // Return on a project name means "done naming", not "next
            // project" — a run of projects is not a thing people do, so
            // this is a plain commit either way.
            onSubmit: submitProjectName,
            onMoveProject: moveProject,
            onMovePin: movePin,
            onOpenTrash: { if interactive { openTrash() } })
            .background(Color(.systemGroupedBackground).ignoresSafeArea())
    }

    /// Add a task, from any state. Shared by the Button and the high-priority
    /// tap that guards it.
    private func capture() {
        if edit.isEditing {
            // The same thing Return does, because a field being open is the
            // only state there is now. Reached when the keyboard is down over
            // the button.
            submitAdding()
        } else {
            startAdding()
        }
    }

    /// The row the depth buttons act on: whatever field is open.
    ///
    /// A sentinel is excluded because it is not in the tree yet — there is no
    /// node for `moveNode` to name, so indent has nothing to reparent. The
    /// buttons grey out on a fresh empty row and come back the moment it is
    /// committed, which is the same row the user is looking at either way.
    private var depthTarget: NodeId? {
        guard let id = edit.editing, !isSentinel(id) else { return nil }
        return id
    }

    /// Whether indent would move the open row. Nothing to nest under when it is
    /// the first among its siblings.
    /// The new row being typed into, when there is one. It has no node for
    /// `indentOp` to move, so the depth buttons plan its slot instead.
    private var activeSentinelEditing: NodeId? {
        guard let id = edit.editing, id == activeSentinel else { return nil }
        return id
    }

    /// Where the sentinel would be filed if committed now: the slot a depth
    /// button chose, or the one below its anchor, or the end of the project.
    /// Pure — `slot(below:)` expands a folded anchor, which a read must not.
    private func plannedSlot(of id: NodeId) -> (parent: NodeId?, index: Int)? {
        if let chosen = sentinelSlot[id] { return chosen }
        guard let anchor = sentinelAnchor[id].flatMap({ $0 }).flatMap({ TreeOps.byId(tree, $0) }) else {
            return (scope, TreeOps.childrenOf(tree, scope).count)
        }
        if !TreeOps.childrenOf(tree, anchor.id).isEmpty { return (anchor.id, 0) }
        guard let i = TreeOps.childrenOf(tree, anchor.parentId)
            .firstIndex(where: { $0.id == anchor.id }) else { return nil }
        return (anchor.parentId, i + 1)
    }

    /// Re-home a sentinel to a new slot and redraw it where that slot is. It
    /// follows the last visible row of whatever precedes it in the new parent,
    /// so it sits exactly where the committed row will appear.
    private func placeSentinel(_ id: NodeId, in slot: (parent: NodeId?, index: Int)) {
        sentinelSlot[id] = slot
        let real = rows.filter { !isSentinel($0.node.id) }
        let parentDepth = slot.parent == scope ? -1
            : (real.first { $0.node.id == slot.parent }?.depth ?? -1)
        let siblings = TreeOps.childrenOf(tree, slot.parent)
        var after: NodeId? = slot.parent == scope ? nil : slot.parent
        if slot.index > 0, slot.index - 1 < siblings.count {
            let prev = siblings[slot.index - 1].id
            after = prev
            if let i = real.firstIndex(where: { $0.node.id == prev }) {
                var j = i
                while j + 1 < real.count, real[j + 1].depth > real[i].depth { j += 1 }
                after = real[j].node.id
            }
        }
        sentinelPlace[id] = (after, parentDepth + 1)
        // The waiting row rides behind at the same depth, so the next Return
        // lands where this one now is.
        if let waiting = sentinels.dropFirst().first?.id {
            sentinelPlace[waiting] = (id, parentDepth + 1)
        }
    }

    /// Make the new row the last child of the sibling above it.
    private func indentSentinel(_ id: NodeId) {
        guard let slot = plannedSlot(of: id), slot.index > 0 else { return }
        let siblings = TreeOps.childrenOf(tree, slot.parent)
        guard slot.index - 1 < siblings.count else { return }
        let prev = siblings[slot.index - 1]
        // Open a folded parent, or the row would be filed out of sight.
        if prev.collapsed { apply(.toggleCollapsed(id: prev.id)) }
        placeSentinel(id, in: (prev.id, TreeOps.childrenOf(tree, prev.id).count))
    }

    /// Make the new row the sibling just after its parent. Never past the
    /// project it is in, the same floor the real rows keep.
    private func outdentSentinel(_ id: NodeId) {
        guard let slot = plannedSlot(of: id), let parentId = slot.parent,
              parentId != scope, let parent = TreeOps.byId(tree, parentId),
              let i = TreeOps.childrenOf(tree, parent.parentId)
                .firstIndex(where: { $0.id == parentId }) else { return }
        placeSentinel(id, in: (parent.parentId, i + 1))
    }

    private var canIndentRow: Bool {
        if let id = activeSentinelEditing {
            return (plannedSlot(of: id)?.index ?? 0) > 0
        }
        guard let id = depthTarget else { return false }
        return TreeOps.canIndent(tree, id)
    }

    /// Whether outdent is allowed — scope-relative, not tree-relative.
    ///
    /// `TreeOps.canOutdent` answers the tree's question (is there a parent?),
    /// which is the wrong one here. Zoomed into a project, that project is the
    /// floor: a row whose parent *is* the scope root would leave the view
    /// entirely and read as having been deleted, with no undo on screen. So the
    /// floor moves with the scope rather than sitting at the tree root.
    ///
    /// At the top level (`scope == nil`) the tree root is the floor, and the
    /// two questions agree.
    private var canOutdentRow: Bool {
        if let id = activeSentinelEditing {
            guard let parent = plannedSlot(of: id)?.parent else { return false }
            return parent != scope
        }
        guard let id = depthTarget, let node = TreeOps.byId(tree, id) else { return false }
        guard let parentId = node.parentId else { return false }
        return parentId != scope
    }

    /// Tuck the open row under its preceding sibling.
    ///
    /// The op comes from `TreeOps.indentOp` rather than being derived here: the
    /// wire carries `moveNode`, and the parent and index it needs follow rules
    /// that belong next to `indent` itself, not copied into a view.
    private func indentRow() {
        if let id = activeSentinelEditing {
            indentSentinel(id)
            return
        }
        guard canIndentRow, let id = depthTarget,
              let op = TreeOps.indentOp(tree, id) else { return }
        apply(op)
    }

    /// Pop the open row up a level, landing after its old parent.
    private func outdentRow() {
        if let id = activeSentinelEditing {
            outdentSentinel(id)
            return
        }
        guard canOutdentRow, let id = depthTarget,
              let op = TreeOps.outdentOp(tree, id) else { return }
        apply(op)
    }

    /// End the session, filing whatever is in the open field.
    ///
    /// The explicit way out, for a row you have typed something into — the
    /// implicit one is Return on an empty row, which is the same exit reached
    /// by a rule rather than by a button. `stopAdding` is both, so a half-typed
    /// row is saved here exactly as blur saves it.
    ///
    /// A glyph rather than the word "Done", to match the two indent buttons
    /// sharing the strip. `checkmark` and not `checkmark.circle.fill`, which is
    /// what a row's own checkbox reaches for when a task is complete — the two
    /// never share a screen edge, but they should not share a weight either.
    @ViewBuilder
    private func doneButton(interactive: Bool) -> some View {
        Button(action: stopAdding) {
            Image(systemName: "checkmark")
                .font(.body.weight(.medium))
                .frame(width: Space.island, height: Space.island)
                .background(.thinMaterial, in: Circle())
                .contentShape(Circle())
        }
        .disabled(!interactive)
        .accessibilityLabel("Done")
        // 12 from the side, a little more than the 8 above the keyboard:
        // matching the two at 8 put them tight against the edge. Not
        // `Space.corner`: these ride above the keyboard, clear of the
        // screen's rounded corners, so nothing holds them that far in.
        .padding(.trailing, 12)
        .padding(.bottom, Space.row)
    }

    /// Indent and outdent, riding the keyboard.
    ///
    /// These are how you move between sequences rather than a way to fix a
    /// mistake, which is why a whole sub-tree costs one indent rather than one
    /// per task — `indentOp` carries the children along.
    ///
    /// Left, so both stay under the thumb and the right side stays clear of
    /// Return. No plus: Return already opens the next row, so there is nothing
    /// for one to do during a session.
    @ViewBuilder
    private func depthButtons(interactive: Bool) -> some View {
        HStack(spacing: 0) {
            Button(action: outdentRow) {
                Image(systemName: "decrease.indent")
                    .frame(width: Space.tap, height: Space.island)
                    .contentShape(Rectangle())
            }
            .disabled(!interactive || !canOutdentRow)
            .accessibilityLabel("Outdent")

            Button(action: indentRow) {
                Image(systemName: "increase.indent")
                    .frame(width: Space.tap, height: Space.island)
                    .contentShape(Rectangle())
            }
            .disabled(!interactive || !canIndentRow)
            .accessibilityLabel("Indent")
        }
        // Outdent first, reading left to right as the direction each one moves
        // the row on screen.
        .font(.body.weight(.medium))
        // One pill holding both, because they are one control with two
        // directions — and a surface under them, so they read as objects
        // floating over the list rather than glyphs loose on the page.
        .background(.thinMaterial, in: Capsule())
        // The Done button's spacing, mirrored — see there.
        .padding(.leading, 12)
        .padding(.bottom, Space.row)
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

    /// Whether there is a screen behind this one. Everything but Home has one:
    /// a project's top level goes back to Home, and the trash to whatever it
    /// was opened over. Home has one only when you came to it from somewhere,
    /// so a stray tap on the pill's Home costs one tap to undo.
    private var canGoBack: Bool {
        inTrash || scope != nil || backFromHome(backTrail)
    }

    /// Whether the edge swipe can take a touch. Not while Search is up: the
    /// swipe would pull the layer sideways while the field wants to shrink
    /// down into the pill. The ✕, the header and bare frost close it.
    private var canSwipeBack: Bool { canGoBack && !inSearch }

    /// The rows the outline draws, flattened depth-first with a folded subtree
    /// counting as the single line it shows.
    private func rows(of scope: NodeId?) -> [(node: Node, depth: Int)] {
        var out: [(node: Node, depth: Int)] = []
        func walk(_ parentId: NodeId?, _ depth: Int) {
            for child in TreeOps.childrenOf(tree, parentId) {
                out.append((child, depth))
                if !child.collapsed { walk(child.id, depth + 1) }
            }
        }
        walk(scope, 0)
        return spliced(sentinels, into: out)
    }

    /// Insert the mounted sentinels into the flattened list at the slot each
    /// records. In order, so the second can follow the first once it is in.
    /// A sentinel whose predecessor is not on screen (a fold closed over it, an
    /// anchor since deleted) goes at the end rather than vanishing — it still
    /// has to be built for focus to have a target.
    private func spliced(
        _ sentinels: [Node], into rows: [(node: Node, depth: Int)]
    ) -> [(node: Node, depth: Int)] {
        guard !sentinels.isEmpty else { return rows }
        var out = rows
        for node in sentinels {
            let place = sentinelPlace[node.id]
            let depth = place?.depth ?? 0
            let after = place?.after
            let i = after.flatMap { a in out.firstIndex { $0.node.id == a } }
            out.insert((node, depth), at: i.map { $0 + 1 } ?? out.count)
        }
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
        addRow()
    }

    /// Make a project and open its name for typing, on Home.
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
        addRow()
        // `addRow` parks focus in the holder and hands it on a turn later, but
        // that handover gives up unless it reads the holder back, and across
        // a screen change focus still reads as the name field for a turn or
        // two. Without this the keyboard stays up with the typing going into
        // the holder.
        if let first = edit.editing { DispatchQueue.main.async { claimFocus(first, triesLeft: 10) } }
    }

    /// Leave the run. The open row is a sentinel: if it has text it becomes a
    /// real task here, and if it is empty it just goes away with the rest of the
    /// sentinels. Nothing to clean up in the tree, because nothing blank was
    /// ever put there.
    private func stopAdding() {
        endRun(releasingFocus: true)
    }

    /// Finish a run: commit the active sentinel (a real task if it had text,
    /// nothing if empty), then clear the mounted sentinels and leave adding
    /// mode. Shared by the checkmark and by every navigation that leaves a run
    /// — going back, opening the trash, zooming home — so all of them end a run
    /// the same way.
    ///
    /// `releasingFocus` false when focus is about to move elsewhere by itself
    /// (a rename taking over), true when the run simply ends and the keyboard
    /// should come down.
    private func endRun(releasingFocus: Bool) {
        if sentinels.isEmpty {
            // Not in a run — a plain rename in progress. Commit it the ordinary
            // way; there is no sentinel to turn into a task.
            commitEdit(releasingFocus: releasingFocus)
        } else {
            commitSentinel()
            edit.endEdit(rememberAnchor: nil)
            if releasingFocus { focusedRow = nil }
            clearSentinels()
        }
    }

    /// Turn the active sentinel into a real task when it has text. The `addChild`
    /// here is the first and only tree write for this row — before it, the row
    /// lived only in `sentinels`. Returns the new node's id, or nil when the row
    /// was left empty (nothing is created, matching the no-blank-tasks rule).
    @discardableResult
    private func commitSentinel() -> NodeId? {
        guard let id = activeSentinel,
              let node = sentinels.first(where: { $0.id == id }) else { return nil }
        let text = edit.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        // A slot the depth buttons chose wins. Otherwise the anchor recorded
        // at mint time, not `edit.captureParent`: focusing the sentinel
        // overwrote that with the sentinel's own id.
        let anchor = sentinelAnchor[id].flatMap { $0 }.flatMap { TreeOps.byId(tree, $0) }
        let place = sentinelSlot[id] ?? slot(below: anchor)
        // Reuse the sentinel's own id, so focus and the field that already hold
        // it keep pointing at the same row as it becomes real.
        apply(.addChild(
            id: node.id, parentId: place?.parent ?? scope, text: text,
            at: Date().timeIntervalSince1970 * 1000))
        if let place {
            apply(.moveNode(id: node.id, parentId: place.parent, index: place.index))
        }
        return node.id
    }

    /// Drop every mounted sentinel. Nothing to un-apply — they were never in the
    /// tree — so this is just clearing local state.
    /// Drop these sentinels only, leaving any minted since.
    private func dropSentinels(_ ids: [NodeId]) {
        sentinels.removeAll { ids.contains($0.id) }
        for id in ids {
            sentinelPlace[id] = nil
            sentinelAnchor[id] = nil
            sentinelSlot[id] = nil
        }
    }

    private func clearSentinels() {
        sentinels.removeAll()
        sentinelPlace.removeAll()
        sentinelAnchor.removeAll()
        sentinelSlot.removeAll()
    }

    /// Create the empty row the user types into, below the anchor.
    ///
    /// Placement follows `slot(below:)`: inside the anchor when it is a parent,
    /// beside it when it is a leaf, or the bottom of the project when no row has
    /// been touched.
    /// Open the first row of a run: a sentinel where the anchor says, and the
    /// waiting sentinel below it, then focus the first. No tree op — the row is
    /// a local view row until it is committed with text.
    ///
    /// Two rows, not one. The waiting sentinel is what Return hands focus to,
    /// and it has to be *already in the list* for the handover: iOS drops the
    /// keyboard the instant no field holds it, so if the next row is built in
    /// the same step that focus moves, the keyboard slides down and back up.
    /// Focusing a cell that already exists moves the field without that gap.
    /// The waiting row is hidden — see the `isWaitingSentinel` modifiers on the
    /// row — so only the one being typed into shows.
    private func addRow() {
        // A rename may still be open — the plus button reaches here from
        // `startAdding` without focus ever changing, so no blur arrives and
        // nothing commits on its own. `begin` below overwrites `edit.text`
        // outright, so without this the typed name is gone with no op emitted
        // and nothing to sync. Focus is not released: it is about to move to
        // the sentinel, and dropping it takes the keyboard down on the way.
        // Only a real row: a sentinel commit goes through `endRun`, which would
        // clear the run this call is part of. Callers reach here with a sentinel
        // open only if `capture`'s adding check is bypassed, and this keeps that
        // from quietly ending the run.
        let leavingEmpty = edit.text.isEmpty
        if let id = edit.editing, !isSentinel(id) { commitEdit(releasingFocus: false) }
        let anchor = edit.captureParent.flatMap { TreeOps.byId(tree, $0) }
        // The visual predecessor the first sentinel follows, and the depth to
        // draw it at. A parent takes its new row as a first child one level in;
        // a leaf takes a sibling at its own depth. Mirrors `slot(below:)`, which
        // is what the eventual `addChild` will use.
        let (after, depth) = sentinelSlot(below: anchor)
        // Both sentinels file under the tapped row; `slot(below:)` turns that
        // into a first-child or sibling placement when the text is committed.
        let first = mintSentinel(after: after, depth: depth, anchor: anchor?.id)
        // The waiting row, directly below the first at the same depth, hidden.
        _ = mintSentinel(after: first.id, depth: depth, anchor: anchor?.id)
        // Focus before anything else. Focusing an id whose row is built in the
        // same render is safe: `focusedRow` is a plain value the field binds to
        // via `.focused(equals:)`, and `rows(of:)` already emits the sentinel.
        edit.begin(id: first.id, text: "")
        // A field is up (a Return on a tapped row, or the plus mid-edit): the
        // new row is built in this same update, so focus waits in the holder.
        if focusedRow != nil {
            holdKeyboard(until: first.id, leavingEmpty: leavingEmpty)
        } else {
            focusedRow = first.id
        }
        scrollInto(first.id)
    }

    /// An invisible field that holds the keyboard while the rows rebuild.
    ///
    /// iOS takes the keyboard down the moment the focused field leaves the
    /// window, and brings it back with the full slide when the next one takes
    /// focus. Moving focus between two rows is safe only when the target row
    /// already exists. A row created in the same update as the focus move, or a
    /// new row whose field is torn down as it is filed, leaves a frame where
    /// nothing is focused. This field is mounted for the whole session and
    /// never moves, so focus can wait here until the target's field is built.
    /// Measured on the phone: without it the keyboard hid and slid back on the
    /// first Return from a tapped row and on tapping away from a new row.
    private var keyboardHolder: some View {
        TextField("", text: $keyboardHolderText)
            .focused($focusedRow, equals: Self.keyboardHolderId)
            // Same return key as the rows, so the keyboard does not redraw it
            // for the one turn it is here.
            .submitLabel(.next)
            // Copied from the field being left, so the keys do not flip
            // between caps and lower case for the turn focus sits here.
            .textInputAutocapitalization(keyboardHolderCaps ? .sentences : .never)
            .frame(width: 1, height: 1)
            .opacity(0.01)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    /// Park focus on `keyboardHolder`, then hand it to `id` a turn later, once
    /// the update that builds `id`'s field has landed.
    private func holdKeyboard(
        until id: NodeId, leavingEmpty: Bool, then landed: (() -> Void)? = nil
    ) {
        keyboardHolderCaps = leavingEmpty
        focusedRow = Self.keyboardHolderId
        DispatchQueue.main.async { handOff(to: id, triesLeft: 10, then: landed) }
    }

    /// Move focus from the holder to `id`, retrying until it sticks. One turn
    /// is not always enough: if `id`'s field is not built yet the write lands
    /// on nothing and focus stays in the holder, where typing goes nowhere
    /// visible. Seen on the phone after Return on a tapped row.
    private func handOff(to id: NodeId, triesLeft: Int, then landed: (() -> Void)?) {
        // Something else claimed focus in the meantime; leave it.
        guard focusedRow == Self.keyboardHolderId else { return }
        focusedRow = id
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) {
            if focusedRow == id {
                landed?()
            } else if focusedRow == Self.keyboardHolderId, triesLeft > 0 {
                handOff(to: id, triesLeft: triesLeft - 1, then: landed)
            } else {
            }
        }
    }

    /// Move focus to `id` and keep at it until it reads back. Unlike `handOff`
    /// it does not first check where focus is — for a caller that knows focus
    /// is somewhere in flight and only cares where it ends up.
    private func claimFocus(_ id: NodeId, triesLeft: Int) {
        guard focusedRow != id, triesLeft > 0 else { return }
        focusedRow = id
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) {
            claimFocus(id, triesLeft: triesLeft - 1)
        }
    }

    /// The row a new sentinel follows and the depth to draw it at — the visual
    /// half of `slot(below:)`. Expands a collapsed parent for the same reason:
    /// the row being typed into must be on screen.
    private func sentinelSlot(below anchor: Node?) -> (after: NodeId?, depth: Int) {
        guard let anchor else { return (rows.last?.node.id, 0) }
        let anchorDepth = rows.first { $0.node.id == anchor.id }?.depth ?? 0
        if !TreeOps.childrenOf(tree, anchor.id).isEmpty {
            if anchor.collapsed { apply(.toggleCollapsed(id: anchor.id)) }
            // First child: directly below the parent, one level in.
            return (anchor.id, anchorDepth + 1)
        }
        return (anchor.id, anchorDepth)
    }

    /// Add a sentinel row to the mounted set and record where it draws (`after`,
    /// `depth`) and where it files (`anchor` — the real tree row it goes below
    /// when committed, or nil to append to the project).
    @discardableResult
    private func mintSentinel(after: NodeId?, depth: Int, anchor: NodeId?) -> Node {
        let node = Node(id: TreeOps.newId(), text: "", order: 0)
        sentinels.append(node)
        sentinelPlace[node.id] = (after, depth)
        sentinelAnchor[node.id] = anchor
        return node
    }

    /// Where a new row goes relative to the row last touched.
    ///
    /// A parent takes it as its first child, a leaf as the sibling under it.
    /// Tapping a row with a list under it reads as "add to this list", and
    /// tapping one with nothing under it as "add next to this" — the same rule
    /// an outline uses on Return. First child rather than last so the new row
    /// appears directly beneath the one that was tapped, wherever the list ends.
    ///
    /// Expands a collapsed parent, since otherwise the row being typed into is
    /// inside a fold and off screen.
    ///
    /// nil when there is no anchor at all; the caller appends to the project.
    private func slot(below anchor: Node?) -> (parent: NodeId?, index: Int)? {
        guard let anchor else { return nil }
        if !TreeOps.childrenOf(tree, anchor.id).isEmpty {
            if anchor.collapsed { apply(.toggleCollapsed(id: anchor.id)) }
            return (anchor.id, 0)
        }
        guard let i = TreeOps.childrenOf(tree, anchor.parentId)
            .firstIndex(where: { $0.id == anchor.id }) else { return nil }
        return (anchor.parentId, i + 1)
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

    /// Commit this row and open the next — what Return does, every time.
    ///
    /// Except on an empty row, which files nothing and ends the session
    /// instead. That is the whole way out: an empty task is not a task, so
    /// saving one can only mean you are done. It also spares the user a second
    /// blank row they would then have to get out of.
    ///
    /// The empty case creates nothing, so there is no blank to clean up. A real
    /// task whose text was cleared goes to the trash, as Enter on an empty row
    /// does on the web; ending the edit instead would commit the empty text,
    /// which deletes it for good.
    ///
    /// The `sentinels.count > 1` fallback below is what makes Return work on a
    /// *tapped* row: `beginEdit` mounts no sentinels, so there is no waiting
    /// row to hop to and this commits and opens one the ordinary way.
    private func submitAdding() {
        guard !edit.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            if let id = edit.editing { removeEmptied(id) } else { stopAdding() }
            return
        }
        // The active sentinel becomes a real task, keeping its id. The waiting
        // sentinel — already mounted, already on screen (though hidden) —
        // becomes the one the cursor moves to, so focus hops to a field that
        // already exists and the keyboard never crosses a frame where nothing
        // is focused. That is the whole reason a row is kept one ahead of the
        // cursor; it is just no longer a real tree node.
        guard let created = commitSentinel(), sentinels.count > 1 else {
            // No waiting sentinel (the run was not opened through `startAdding`).
            // Fall back to committing and opening a fresh row.
            commitEdit(releasingFocus: false)
            clearSentinels()
            addRow()
            return
        }
        // The committed row is now the anchor, so the next task slots below it.
        edit.captureParent = created
        // Drop the just-committed sentinel; the waiting one is now first.
        sentinels.removeFirst()
        let next = sentinels[0]
        // Re-place the (previously hidden) waiting row below the committed row,
        // hand focus to it, then mint the new waiting row below that. Focus
        // first, mint second: reversing them puts a list rebuild between the
        // commit and the focus move, which is the keyboard gap again.
        let depth = rows.first { $0.node.id == created }?.depth ?? 0
        // The next task is a sibling of the row just committed, so both the
        // promoted waiting row and the new one behind it file under `created`.
        sentinelPlace[next.id] = (created, depth)
        sentinelAnchor[next.id] = .some(created)
        edit.begin(id: next.id, text: "")
        focusedRow = next.id
        scrollInto(next.id)
        mintSentinel(after: next.id, depth: depth, anchor: created)
    }

    /// Backspace or Return on an empty row. Matches `deleteRow` in
    /// `src/Outliner.tsx`: the row goes to the trash, and the keyboard comes
    /// down rather than the cursor stepping into the row above, so repeated
    /// presses cannot work their way up the project.
    ///
    /// The trash keeps the name the row had before it was cleared, since the
    /// clearing was never committed.
    ///
    /// A sentinel is not in the tree, so there is nothing to delete and this
    /// just ends the run.
    private func removeEmptied(_ id: NodeId) {
        guard edit.editing == id else { return }
        if isSentinel(id) {
            stopAdding()
            return
        }
        // The edit ends before focus is cleared, so the blur that follows
        // finds nothing to commit. Committing an empty row deletes it for good,
        // not to the trash.
        edit.endEdit(rememberAnchor: nil)
        focusedRow = nil
        delete(id)
    }

    /// A deliberate delete, so the subtree is kept and can be restored.
    ///
    /// `trash: true` here and on the project delete, and nowhere else. The other
    /// `removeNode` is an editing mechanic — `commitEdit` dropping a row left
    /// blank — and a trash full of empty strings is no use for the deletes that
    /// matter.
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
    ///
    /// - Parameter step: what Back from `id` returns to, when it is not simply
    ///   the screen being left. Search passes itself, so Back comes back to it
    ///   with the query.
    private func setScope(_ id: NodeId?, leaving step: BackStep? = nil) {
        // Here rather than in the callers that navigate. A run and its anchor
        // are both facts about one scope, so any move out of that scope ends
        // them — and `openProject`/`zoomOut` clearing them individually left
        // the home button, which calls this directly, showing a checkmark on
        // the grid with no run to end.
        if id != scope {
            // A run and its anchor belong to the scope being left. `endRun`
            // commits the row being typed — a real task if it has text, nothing
            // if empty — and drops the mounted sentinels, so navigating out can
            // never leave a blank behind.
            endRun(releasingFocus: true)
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
        if id != scope || step != nil {
            backTrail.append(step ?? BackStep(scope: scope, at: topRowAnchor()))
            if backTrail.count > 200 { backTrail.removeFirst() }
        }
        // Going *into* a place stamps it as just-visited, which is what
        // Recently visited and resume read. Going up (home, a breadcrumb to an
        // ancestor, the fallback when a scope is deleted) stamps nothing, so
        // passing back through a parent doesn't count as visiting it. The same
        // rule as the web's `setScope`. A place picked in Search is gone to,
        // never passed through, so it counts even when it is above you.
        let goingUp = id == nil
            || (step?.search == nil && scope.map { here in TreeOps.lineageOf(tree, here).contains { $0.id == id } } ?? false)
        scope = id
        if let id, !goingUp {
            apply(.markOpened(id: id, at: Date().timeIntervalSince1970 * 1000))
        }
    }

    /// Go to the trash.
    ///
    /// A run in progress is committed first, the same as any other move: the
    /// waiting row is a real empty node, and leaving it behind would be a blank
    /// task. `scope` is untouched — the trash draws over it, and back restores
    /// the grid it was opened from.
    private func openTrash() {
        endRun(releasingFocus: true)
        trashOverSearch = nil
        inTrash = true
    }

    /// Home, from the pill. Through `setScope`, so Back from the project you
    /// open next returns here.
    private func goHome() {
        // Home arrives under the frost at once, and Search shrinks back into
        // the pill over it, so the page being left is never seen swapping.
        // From Home itself there is no new page, so it just closes.
        if inSearch {
            guard scope != nil || inTrash else {
                closeSearch()
                return
            }
            // The new page's field picks this up on appearing and shrinks.
            searchLeaving = true
            searchFocused = false
        }
        trashOverSearch = nil
        inTrash = false
        guard scope != nil else { return }
        setScope(nil)
    }

    /// Open Search over the current screen, empty and with the keyboard up.
    private func openSearch() {
        endRun(releasingFocus: true)
        autoScope = false
        searchReturn = scope == nil || inTrash ? nil : topRowAnchor()
        trashOverSearch = nil
        query = ""
        if inSearch {
            // Caught mid-shrink: grow back from wherever it got to.
            withAnimation(searchMotion) { searchSpot = .up }
        } else {
            // The field arrives tucked and grows itself, on appearing.
            searchSpot = .tucked
            inSearch = true
        }
        // A turn later: the field is built by this change, and focus aimed at
        // a field that does not exist yet is dropped.
        DispatchQueue.main.async { searchFocused = true }
    }

    /// Back to the screen Search was opened over, which is still there under
    /// it. The field shrinks back into the pill, then Search goes.
    private func closeSearch() {
        guard inSearch else { return }
        searchFocused = false
        withAnimation(searchMotion) {
            searchSpot = .tucked
        } completion: {
            // Unless it was opened again while shrinking.
            guard searchSpot == .tucked, inSearch else { return }
            inSearch = false
        }
    }

    /// Go to a place picked in Search. Back from there returns to Search with
    /// what was typed.
    ///
    /// `arriving` is a match rather than a place: it opens onto its parent,
    /// scrolled to and lit, so it is seen among its siblings. A project has no
    /// parent and opens as itself.
    private func openFromSearch(_ id: NodeId, arriving: Bool = false) {
        let step = BackStep(scope: scope, at: searchReturn, search: query, trash: inTrash)
        searchFocused = false
        inSearch = false
        inTrash = false
        guard arriving, let parent = TreeOps.byId(tree, id)?.parentId else {
            setScope(id, leaving: step)
            return
        }
        setScope(parent, leaving: step)
        restore = ScrollAnchor(row: id, fraction: 0.3)
        arrival = id
        // Held long enough to find, then faded. A later arrival owns the
        // light, so this one leaves it alone.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
            guard arrival == id else { return }
            withAnimation(.easeOut(duration: 0.8)) { arrival = nil }
        }
    }

    /// The trash, from Search's "in Trash" line. Back returns to Search.
    private func openTrashFromSearch() {
        trashOverSearch = query
        searchFocused = false
        inSearch = false
        inTrash = true
    }

    /// Open a project: zoom in, and record that it was opened.
    ///
    /// The timestamp is minted here and carried by the op, so the server stores
    /// the instant this device opened it rather than whenever the write landed.
    /// Matches `openProject` in `src/Outliner.tsx`.
    private func openProject(_ id: NodeId) {
        // The run, the anchor and the visit stamp are all handled by
        // `setScope`, which every navigation goes through.
        // Out of the trash too: a project opened from Home is where you are
        // going, and the trash sitting over it would hide it.
        inTrash = false
        setScope(id)
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
        // A sentinel is a waiting row, not a tree node — dragging one would let
        // `endDrag` emit a move op against an id the tree does not have.
        guard !isSentinel(id) else { return }
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
            // A parent draws no segment of its own guide — the run starts at
            // its first child. The lit run down to the drop point and
            // `parentHighlight` on the parent row already say where the drop
            // lands; a half-line on the parent's own row only restated that.
            let here = TreeOps.guidesThrough(all, at: i)
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
                        // Full `nest`, matching the parent outline's stroke —
                        // the lit run and the outline are one cue and read as
                        // one weight. Dimmer, the line looked unlit beside it.
                        .fill(lit
                            ? AnyShapeStyle(DropPalette.nest)
                            : AnyShapeStyle(Color.primary.opacity(0.12)))
                        .frame(width: lit ? 2 : 1.5, height: h)
                        .offset(x: OutlineRow.guideX0
                            + CGFloat(guide.depth) * OutlineRow.indent - 0.75)
                        .animation(.easeOut(duration: 0.12), value: lit)
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
    /// `.into` cuts at the parent's own row, so nothing down the guide lights:
    /// when the parent already has children, the run of their guide restated the
    /// nest that the children themselves already show, and `parentHighlight`
    /// carries the cue on its own. (A childless parent has no guide to light
    /// either way.)
    private var litUntilRow: Int {
        if let target = drag.target, target.mode == .into,
           let i = rows.firstIndex(where: { $0.node.id == target.id }) {
            return i
        }
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
        // Filing a new row rebuilds its field, so its focus cannot pass straight
        // to the tapped row. See `keyboardHolder`.
        let leavingNewRow = edit.editing.map(isSentinel) ?? false
        let leavingEmpty = edit.text.isEmpty
        // Save the row being left before `begin` takes its place. The old
        // field's blur does arrive, but after `begin` has already replaced
        // `edit.editing` and `edit.text` with this row's — so `shouldCommit`
        // turned it away and the typed text was lost. Tapping another task is
        // a save, never a discard.
        // Except an empty new row, which has nothing to save and is only
        // dropped. Dropping it now deletes the list cell holding the keyboard
        // in the same update that moves focus, and iOS took the keyboard down
        // for that. It stays mounted until focus has landed on the tapped row.
        let leftEmpty = wasEditing && leavingNewRow && leavingEmpty
            ? sentinels.map(\.id) : nil
        if wasEditing, edit.editing != node.id, leftEmpty == nil {
            commitEdit(releasingFocus: false)
        }
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
        if let leftEmpty {
            holdKeyboard(until: node.id, leavingEmpty: true) {
                dropSentinels(leftEmpty)
            }
        } else if wasEditing, leavingNewRow {
            holdKeyboard(until: node.id, leavingEmpty: leavingEmpty)
        } else if wasEditing {
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
        // A sentinel is not in the tree, so `TreeOps.commitEdit` can only ever
        // no-op on it — it knows `setText`/`removeNode`, not the `addChild` a
        // sentinel needs to become a real node. Tapping away from a sentinel
        // row (blur, not Return) lands here; route it through the run's own
        // commit so the typed text is not silently dropped.
        if isSentinel(id) {
            endRun(releasingFocus: releasingFocus)
            return
        }
        let op = TreeOps.commitEdit(tree, id, edit.text)
        if let op { apply(op) }

        // Remember it only if it still exists: an emptied row is deleted by
        // `commitEdit`, and anchoring to a node that just went away would send
        // the new task back to the bottom with the chip still claiming
        // otherwise.
        edit.endEdit(rememberAnchor: TreeOps.byId(tree, id) == nil ? nil : id)
        if releasingFocus { focusedRow = nil }
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
                guard canSwipeBack, armed(g), g.translation.width > backThreshold else {
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
                //
                // On the animation's completion, not a timer of the same
                // length. The timer fired a frame or two early, and an
                // animation still in flight keeps playing out its remainder on
                // top of the new value: the incoming view drew ~60pt left of
                // its place and slid back.
                withAnimation(.easeOut(duration: 0.18)) {
                    backPull = slideOut
                } completion: {
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
        canSwipeBack && !drag.isActive && !rowSwiping && g.startLocation.x < backClaim
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
        canSwipeBack
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
        // Search sits over the screen it was opened from, the way the trash
        // does.
        if inSearch {
            closeSearch()
            return
        }
        if inTrash {
            inTrash = false
            if let search = trashOverSearch {
                trashOverSearch = nil
                query = search
                searchSpot = .low
                inSearch = true
            }
            return
        }
        // Zooming out changes where a new task would land, so the run and its
        // anchor both go with it. Done here rather than inherited from
        // `setScope`, because this deliberately does not call it: `setScope`
        // would push the step being undone and leave back bouncing between two
        // scopes.
        endRun(releasingFocus: true)
        edit.captureParent = nil
        autoScope = false
        let step = popBack()
        scope = step.scope
        if let search = step.search {
            // Back to Search as it was left, keyboard down: you came back to
            // look at the list, not to type.
            inTrash = step.trash
            query = search
            searchReturn = step.at
            searchSpot = .low
            inSearch = true
            // The page is under Search now, so put it back where it was.
            restore = step.trash ? nil : step.at
        } else {
            restore = step.at
        }
    }

    /// Take the next step back, spending it. `peekBack` decides where; this
    /// clears the trail down to it.
    private func popBack() -> BackStep {
        let step = peekBack
        backTrail = trail(afterBack: step)
        return step
    }

    /// The trail once back has landed on `step`: everything down to and
    /// including it dropped, so the skipped-over dead scopes do not sit waiting
    /// for the next back.
    private func trail(afterBack step: BackStep) -> [BackStep] {
        guard let i = backTrail.lastIndex(where: { $0.scope == step.scope }) else { return [] }
        return Array(backTrail[..<i])
    }

    /// Bottom to top. The layer behind exists only while a back swipe is
    /// pulled; the two keys never match, since back always changes the scope
    /// or leaves the trash.
    private var slabLayers: [SlabLayer] {
        let live = SlabLayer(
            scope: scope, trash: inTrash, search: inSearch ? query : nil,
            live: true, restoring: restore, homeBack: backFromHome(backTrail))
        guard backPull > 0 else { return [live] }
        // `inTrash` is read by `slab` itself, so the copy behind a trash pull
        // has to be drawn with it already false — otherwise the screen
        // revealed is a second trash. Back from the trash lands on the scope
        // it was opened over, which is still `scope`. Search the same, one
        // layer up: it lands on the trash if that is what it covered.
        let behind: SlabLayer
        if inSearch {
            behind = SlabLayer(
                scope: scope, trash: inTrash, search: nil, live: false,
                restoring: inTrash ? nil : searchReturn,
                homeBack: backFromHome(backTrail))
        } else if inTrash {
            behind = SlabLayer(
                scope: scope, trash: false, search: trashOverSearch, live: false,
                restoring: nil)
        } else {
            // Drawn with the trail it will have once it lands, so Home's Back
            // is already what it will be rather than appearing on arrival.
            let step = peekBack
            behind = SlabLayer(
                scope: step.scope, trash: step.trash, search: step.search, live: false,
                restoring: step.search == nil ? step.at : nil,
                homeBack: backFromHome(trail(afterBack: step)))
        }
        return [behind, live]
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
            // No scope is Home, which is always there.
            guard let id = step.scope else { return step }
            if TreeOps.byId(tree, id) != nil { return step }
        }
        // Off the end of the trail: the tree parent, with nowhere remembered.
        return BackStep(scope: parentScope, at: nil)
    }

    /// Whether Home, with this trail, has somewhere to go back to: the place
    /// you left for it, when you came from one. `peekBack`'s walk, but running
    /// off the end means no Back rather than the tree parent, which from Home
    /// is Home again.
    private func backFromHome(_ trail: [BackStep]) -> Bool {
        guard let step = trail.last(where: { step in
            step.scope.map { TreeOps.byId(tree, $0) != nil } ?? true
        }) else { return false }
        return step.scope != nil || step.search != nil || step.trash
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

/// The Home and Search pill: `CaptureButtonSurface` in a capsule.
private struct PillSurface: ViewModifier {
    /// False for Search's field while it is tucked into the pill, which is
    /// already glass around it.
    var shown = true

    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content.glassEffect(shown ? .regular.interactive() : .identity, in: .capsule)
        } else {
            content
                .background(Capsule().fill(.regularMaterial).opacity(shown ? 1 : 0))
                .shadow(color: .black.opacity(shown ? 0.12 : 0), radius: 6, y: 2)
        }
    }
}

extension View {
    /// A header under Search: soft and pale enough to read as behind the
    /// results, sharp enough to still say where closing Search goes.
    func veiled(_ on: Bool) -> some View {
        blur(radius: on ? 1.5 : 0).opacity(on ? 0.6 : 1)
    }
}

/// Back's path box: Liquid Glass where the OS has it, a plain card elsewhere.
/// The same availability fork as `CaptureButtonSurface`, at the box's 16pt
/// corner rather than the glass popover's own.
private struct PathBoxSurface: ViewModifier {
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: 16)
        if #available(iOS 26, *) {
            content.glassEffect(.regular, in: shape)
        } else {
            content
                .background(Color(.secondarySystemGroupedBackground), in: shape)
                .overlay(shape.strokeBorder(Color(.separator), lineWidth: 0.5))
                .shadow(color: .black.opacity(0.15), radius: 10, y: 4)
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

/// One of the screens stacked in the body: the live one, and during a back
/// swipe the one behind it that the swipe will land on.
struct SlabLayer {
    let scope: NodeId?
    let trash: Bool
    /// The query, when the screen is Search.
    let search: String?
    let live: Bool
    let restoring: ScrollAnchor?
    /// Whether Home, if this is Home, draws Back.
    var homeBack = false
    /// What the screen shows, which is what carries it across the swap. Not
    /// the query, or every keystroke would rebuild the screen, and not whether
    /// Search is up: Search is a layer over the page, which stays where it was
    /// underneath.
    var key: String { "\(scope ?? "")|\(trash)" }
}

/// Where Search's field sits.
enum SearchSpot {
    /// Exactly the pill's Search half, with no glass of its own: where it grows
    /// from and shrinks back into.
    case tucked
    /// Full width on the keys.
    case up
    /// Keyboard down, on the pill's line beside Home.
    case low
}

/// One step of the back trail: the scope, and where the list was looking.
struct BackStep {
    let scope: NodeId?
    let at: ScrollAnchor?
    /// Set when the step is Search: what was typed, to put back. `scope` and
    /// `trash` are then the screen Search was opened over.
    var search: String? = nil
    var trash = false
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
            .frame(height: 6)

            Text(label)
                .font(.subheadline)
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
        .padding(.vertical, Space.row)
        // The same material the header carries, continued down so the bar
        // reads as the foot of the header band rather than a strip floating on
        // its own. The two abut with no gap, so one `.bar` runs unbroken.
        .background(.bar)
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
        // A name and nothing else. The path it used to open as a menu is on
        // Back's long-press now.
        if editing {
            nameField
        } else {
            titleLabel
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
                .font(.title3.weight(.semibold))
                .onChange(of: editText) { _, text in
                    let clamped = TreeOps.clampText(text)
                    if clamped != text { editText = clamped }
                }
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

    /// How wide the title may be: the screen less the space the leading and
    /// trailing buttons occupy. Back is a chevron and the exit is a house, so
    /// the reserve is the same on both sides and the title stays centred.
    private var titleWidth: CGFloat {
        // Less the header's four stack gaps too (button, spacer, title, spacer,
        // button). Leaving them out made the header 32pt wider than the
        // screen, which pushed the whole column 16pt past each edge — the
        // progress bar's gutter was there, just off screen.
        UIScreen.main.bounds.width - buttonZone * 2 - Space.row * 4
    }

    /// A header button's 44pt target. The glyph sits 8pt from the screen edge
    /// inside it, so the band needs no inset of its own and every point goes
    /// to the title.
    private let buttonZone: CGFloat = 44

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
        Text(title)
            .font(.title3.weight(.semibold))
            .lineLimit(1)
            .truncationMode(.tail)
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
    var icon: String = "antenna.radiowaves.left.and.right.slash"
    let text: String
    /// When set, the banner carries a close button. The offline one does not:
    /// it clears itself when the connection comes back, and a dismissed one
    /// would hide a state that is still true.
    var onDismiss: (() -> Void)?

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
            Text(text)
            Spacer()
            if let onDismiss {
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss")
            }
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

    /// Above a section header, and above a headerless section's card so the two
    /// kinds of break read the same. Half `block`: the header's own height is
    /// most of what sets a section off, so the space above it only has to keep
    /// it from touching the card before it.
    static let sectionBreak: CGFloat = 6

    /// Above a headerless section's card. Half a row: the full span a header
    /// makes is too much when nothing is written in it — an empty gap reads
    /// larger than the same gap with a header sitting in it.
    static let headerBreak: CGFloat = tap / 2

    /// The shortest a row on the home screen is allowed to be.
    ///
    /// Above Apple's 44pt minimum, which the rows already met on content alone
    /// — this is for the room, not the tap target. A minimum rather than a
    /// fixed height: the rows hold different things, and at large Dynamic Type
    /// a fixed one would clip whichever row outgrew it.
    static let tap: CGFloat = 48

    /// The drawn height of a control floating over the keyboard.
    ///
    /// Matched to the keyboard below it: a space bar measures 43pt. 36 was
    /// tried first and read as too small on a device.
    static let island: CGFloat = 44

    /// The screen edge. Anything that has to line up with another section's
    /// left edge measures from here.
    static let gutter: CGFloat = 16
    /// How far a corner control sits from the two screen edges it floats over.
    ///
    /// 24 lines the pill's left edge up with the outer edge of a
    /// bullet's ring above it (17 inset + 7 to the ring inside its 32pt
    /// column). 36 left the pair standing out in the open.
    static let corner: CGFloat = 24
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
    let onBeginEdit: () -> Void
    let onBlur: (NodeId) -> Void
    let onSubmit: () -> Void
    /// Backspace on this row while it is empty. See `EmptyBackspace`.
    let onBackspaceEmpty: () -> Void
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
    /// Puts the second-level guide 50pt in, where it ran through the centre
    /// of the round button that once sat in the bottom-left corner. The
    /// pill's Home oval is wider and centres 6pt right of that; the guides
    /// stay put rather than narrowing every row to follow it.
    static let railInset: CGFloat = 50 - 16 - indent

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

            // Guarded like the text's Button below: a swipe that starts on the
            // box delivers its tail as a tap, which ticked the task.
            Button(action: { if !justSwiped { onToggleDone() } }) {
                Checkbox(done: node.done, groupDone: groupDone)
                    .frame(width: 32, height: 40)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // The box sits 20pt from a leaf's dot and 20pt from the text —
            // equal around the mark most rows show, since most tasks are
            // leaves, and the same step as one indent. A parent's 18pt ring
            // comes 6pt closer, to 14. With the plain spacing the gaps were
            // 29.5 from the dot (13 + 10 + 6.5, the empty parts of both
            // columns plus the gap) and 16.5 to the text (6.5 + 10). The
            // leading pull still leaves 0.5 between this tap column and the
            // bullet's.
            //
            // The trailing is 1 short of the 20: a letter carries ~1pt of its
            // own space before the ink, so the visible gap lands on 20.
            .padding(.leading, -9.5)
            .padding(.trailing, 2.5)

            // Tap the label to rename in place. The field replaces the text
            // rather than sitting beside it, so the row does not reflow when
            // editing starts and the words stay exactly where they were.
            Group {
                if editing {
                    TextField("", text: $editText, axis: .vertical)
                        .textFieldStyle(.plain)
                        // Caps only on an empty row. Focusing a row that has
                        // text flashed the keys to caps for a frame (the shift
                        // is judged before the cursor reaches the end), so a
                        // row with text never asks for a capital.
                        .textInputAutocapitalization(editText.isEmpty ? .sentences : .never)
                        .focused($focusedRow, equals: node.id)
                        // Return commits this row and opens another, so the key
                        // says the one true thing about it. Not `.done`, which
                        // is now the checkmark's job at the end of the bar —
                        // and which iOS draws here as a bare ✓, a glyph this
                        // app already spends on marking a task complete.
                        //
                        // `.next` is the closest of the nine `UIReturnKeyType`
                        // cases; none of them says "add". The key takes an enum,
                        // not a string, so there is no wording to choose here.
                        .submitLabel(.next)
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
                            // Clamp as you type, so the limit is hit at the
                            // keyboard rather than on sync.
                            let clamped = TreeOps.clampText(text)
                            if clamped != text { editText = clamped }
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
                        // The notification names no row, so only the focused
                        // one answers it. The text is checked again because
                        // the field and the binding can be a frame apart.
                        .onReceive(NotificationCenter.default.publisher(for: .emptyBackspace)) { _ in
                            guard focusedRow == node.id, editText.isEmpty else { return }
                            onBackspaceEmpty()
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

    @ScaledMetric(relativeTo: .body) private var growth: CGFloat = 1
    private var k: CGFloat { min(growth, Bullet.maxGrowth) }

    var body: some View {
        RoundedRectangle(cornerRadius: 5 * k)
            .strokeBorder(
                done ? AnyShapeStyle(.clear) : AnyShapeStyle(.secondary), lineWidth: 2 * k)
            .background(
                RoundedRectangle(cornerRadius: 5 * k)
                    .fill(done ? AnyShapeStyle(fill) : AnyShapeStyle(.clear)))
            .frame(width: 19 * k, height: 19 * k)
            .overlay {
                if done {
                    Image(systemName: "checkmark")
                        .font(.system(size: 11 * k, weight: .bold))
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

    /// How far the marks grow with the text, at most. Both sit in 32pt columns
    /// that stay put — the depth guides and the drag's indent steps are
    /// measured in them — so a ring can reach 25pt and still leave a gap to
    /// the checkbox beside it. The checkbox shares the cap.
    static let maxGrowth: CGFloat = 1.4

    @ScaledMetric(relativeTo: .body) private var growth: CGFloat = 1
    private var k: CGFloat { min(growth, Self.maxGrowth) }

    var body: some View {
        ZStack {
            if hasChildren {
                if collapsed {
                    // The disc is now the only thing saying children are hidden
                    // here — both the chevron and the count came off the row.
                    Circle()
                        .fill(lit ? AnyShapeStyle(DropPalette.nest)
                                  : AnyShapeStyle(.secondary))
                        .frame(width: 18 * k, height: 18 * k)
                } else {
                    Circle()
                        .strokeBorder(lit ? AnyShapeStyle(DropPalette.nest)
                                          : AnyShapeStyle(.secondary),
                                      lineWidth: 2 * k)
                        .frame(width: 18 * k, height: 18 * k)
                }
            } else if lit {
                // A leaf has no surround to light, so it grows the ring the
                // expanded state already has. Same shape, so the row about to
                // become a parent previews what it is about to look like.
                Circle()
                    .strokeBorder(DropPalette.nest, lineWidth: 2 * k)
                    .frame(width: 18 * k, height: 18 * k)
            }
            // Never lit. The dot is the one part that means the same thing in
            // every state, and a brass dot on a brass disc would erase it.
            Circle()
                .fill(.primary)
                .frame(width: 6 * k, height: 6 * k)
        }
        .frame(width: 18 * k, height: 18 * k)
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
                            // This row has no header. Matching the header's
                            // *inset* alone left it far tighter than every other
                            // break on the screen; matching the header's whole
                            // span was too much, empty.
                            gapAbove: Space.headerBreak,
                            // Trash is a place, not a project. The line says so
                            // before the row has been read.
                            divider: true))
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
            // 0/0 for an empty project, not the 0/1 `progressOf` returns.
            // That rule counts a childless node as one unit of itself so a bare
            // task still reads 0% or 100% — right for a task, wrong for a
            // project, which is a container and not a thing to check off. The
            // card hides the count when `total` is 0, so this reads as nothing
            // rather than as one task waiting.
            progress: TreeOps.childrenOf(tree, project.id).isEmpty
                ? TreeOps.Progress(done: 0, total: 0, pct: 0)
                : TreeOps.progressOf(tree, project.id),
            editing: editing == project.id,
            editText: $editText,
            focused: focused,
            onOpen: { onOpen(project.id) },
            onSubmit: onSubmit)
            // No context menu. Long-press is the reorder drag here, and a
            // menu on the same press wins it outright — the drag never starts.
            // Rename and delete live in the project's own `...`.
            // The same insets as a pinned row. Without this the card took
            // the sidebar's defaults while the pinned row declared 16, so the
            // two sections started at different x — the most visible unearned
            // difference on the screen. Both are two-line rows; what should
            // separate them is the type, not the margin.
            .listRowInsets(
                EdgeInsets(
                    top: Space.inner, leading: Space.gutter,
                    bottom: Space.inner, trailing: Space.gutter))
            // No swipe to delete: it would put a project a short thumb away
            // from the trash. Delete is in the project's own `...`.
    }
}

/// A home-screen section header, which folds its section when given `open`.
///
/// The chevron and the tap are drawn here because `Section(isExpanded:)` only
/// folds under the list styles whose card this screen had to stop using.
private struct SectionHeader: View {
    let title: String
    var open: Binding<Bool>? = nil

    var body: some View {
        Button {
            open?.wrappedValue.toggle()
        } label: {
            HStack {
                Text(title)
                Spacer()
                if let open {
                    Image(systemName: "chevron.down")
                        // Rotated rather than swapped for `chevron.right`: a
                        // glyph swap cuts, and the turn is what says the
                        // section moved.
                        .rotationEffect(.degrees(open.wrappedValue ? 0 : -90))
                        .font(.footnote.weight(.semibold))
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .allowsHitTesting(open != nil)
        .foregroundStyle(.secondary)
        .textCase(nil)
        .font(.subheadline.weight(.semibold))
        // The page's own grey, out past the insets to the header's full span.
        // A `.plain` list pins its headers over a translucent ground, so a row
        // scrolling under read through the title. `.listRowBackground` does not
        // reach a header.
        .background(
            Color(.systemGroupedBackground)
                .padding(
                    EdgeInsets(
                        top: -Space.sectionBreak, leading: -Space.gutter,
                        bottom: -Space.row, trailing: -Space.gutter)))
        .listRowInsets(
            EdgeInsets(
                top: Space.sectionBreak, leading: Space.gutter,
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
    /// A hairline across the middle of `gapAbove`, for a row that belongs to a
    /// different kind of thing than the list above it.
    var divider = false

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
                .overlay(alignment: .top) {
                    if divider {
                        Rectangle()
                            .fill(Color(.separator))
                            .frame(height: 1 / UIScreen.main.scale)
                            .padding(.top, gapAbove / 2)
                    }
                }
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

    /// For the name's line limit, which follows `ProjectRow`'s.
    @Environment(\.dynamicTypeSize) private var typeSize

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
                        .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)

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

/// Search. Before anything is typed, the places you were in last, newest
/// first; after, what matches, on Home's cards either way. The field is the
/// slab's bottom inset rather than part of this, so it can ride the keyboard.
private struct SearchPage: View {
    let tree: Tree
    let store: OutlineStore
    let query: String
    /// The place Search was opened from. Left off Recently visited, since you
    /// are in it, and its project's matches are listed first.
    let from: NodeId?
    /// A place in Recently visited, opened as itself.
    let onOpen: (NodeId) -> Void
    /// A match, opened where it sits.
    let onFind: (NodeId) -> Void
    let onOpenTrash: () -> Void
    /// A tap on the list, which takes the keyboard down.
    let onTapAway: () -> Void
    /// A tap on the bare frost below the list, which closes Search.
    let onTapBare: () -> Void

    /// The trash, read once when Search opens. Deleted nodes are not in the
    /// tree, so this is the only way to know a match is in there.
    @State private var trash: [TrashEntry] = []
    /// Where the list's last row ends, in the list's own space. Below it is
    /// bare frost. Infinite while the end is scrolled out of sight, when
    /// there is none.
    @State private var end: CGFloat = .infinity

    var body: some View {
        List {
            if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                recent
            } else {
                results
            }
            // Marks the end of the list, for telling a tap on a row from a
            // tap on the frost below them.
            Color.clear
                .frame(height: 1)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .onGeometryChange(for: CGFloat.self) {
                    $0.frame(in: .named(Self.space)).minY
                } action: { end = $0 }
                .onDisappear { end = .infinity }
        }
        .listStyle(.plain)
        // Clear: the frost under it is the ground.
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.immediately)
        .coordinateSpace(.named(Self.space))
        .simultaneousGesture(
            SpatialTapGesture(coordinateSpace: .named(Self.space)).onEnded { tap in
                if tap.location.y > end { onTapBare() } else { onTapAway() }
            })
        .task { await loadTrash() }
    }

    private static let space = "searchPage"

    @ViewBuilder private var recent: some View {
        let places = TreeOps.recentlyVisited(tree, excluding: from)
        // The heading alone when there is nothing yet: an empty state
        // explaining visits would be longer than the list it stands for.
        Section {
            ForEach(Array(places.enumerated()), id: \.element.id) { i, node in
                PlaceRow(
                    name: Text(node.text.isEmpty ? "Untitled" : node.text),
                    trail: trail(of: node), finished: finished(node), struck: false,
                    onOpen: { onOpen(node.id) })
                    .modifier(SearchCard(i: i, of: places.count))
            }
        } header: {
            SectionHeader(title: "Recently visited")
        }
    }

    @ViewBuilder private var results: some View {
        let found = TreeOps.search(tree, query, from: from)
        let binned = trash.filter { !TreeOps.matchRanges($0.text, query).isEmpty }.count
        if found.here.isEmpty && found.elsewhere.isEmpty {
            Section {
                Text("Nothing matches \u{201C}\(query.trimmingCharacters(in: .whitespaces))\u{201D}")
                    .foregroundStyle(.secondary)
                    .listRowInsets(EdgeInsets(top: Space.inner, leading: Space.gutter, bottom: Space.inner, trailing: Space.gutter))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
        }
        if !found.here.isEmpty {
            group(found.here, finished: found.finished, title: "In \(projectName)")
        }
        if !found.elsewhere.isEmpty {
            // "Other projects" only means something after an "In" group. Opened
            // from Home there is one list, and it is just the results.
            group(
                found.elsewhere, finished: found.finished,
                title: from == nil ? "Results" : "Other projects")
        }
        if binned > 0 {
            // One line rather than the deleted tasks themselves: they cannot
            // be opened where they were, and mixed in with live ones they
            // would read as still there.
            Button(action: onOpenTrash) {
                HStack(spacing: Space.row) {
                    Image(systemName: "trash")
                    Text("\(binned) in Trash")
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                }
                .foregroundStyle(.secondary)
                .frame(minHeight: Space.tap)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .listRowInsets(EdgeInsets(top: 0, leading: Space.gutter + Space.inner, bottom: 0, trailing: Space.gutter + Space.inner))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
        }
    }

    private func group(_ nodes: [Node], finished: Set<NodeId>, title: String) -> some View {
        Section {
            ForEach(Array(nodes.enumerated()), id: \.element.id) { i, node in
                let done = finished.contains(node.id)
                PlaceRow(
                    name: Text(FoundPalette.marked(node.text.isEmpty ? "Untitled" : node.text, query, dim: done)),
                    trail: trail(of: node), finished: false, struck: done, matched: true,
                    onOpen: { onFind(node.id) })
                    .modifier(SearchCard(i: i, of: nodes.count))
            }
        } header: {
            SectionHeader(title: title)
        }
    }

    private var projectName: String {
        guard let from, let root = TreeOps.lineageOf(tree, from).first else { return "" }
        return root.text.isEmpty ? "Untitled" : root.text
    }

    /// Where the place is, above it: "Lisbon trip › Itinerary", or "Project"
    /// for a project, which has nothing above it to name.
    private func trail(of node: Node) -> String {
        let above = TreeOps.lineageOf(tree, node.id).dropLast()
        guard !above.isEmpty else { return "Project" }
        return above.map { $0.text.isEmpty ? "Untitled" : $0.text }.joined(separator: " › ")
    }

    /// `recentlyVisited`'s own test for what sinks to the bottom.
    private func finished(_ node: Node) -> Bool {
        let p = TreeOps.progressOf(tree, node.id)
        return p.total > 0 && p.done == p.total
    }

    /// Every page, up to a bound. Offline, or on any failure, the list simply
    /// has no trash line: search still works on everything that is live.
    private func loadTrash() async {
        var entries: [TrashEntry] = []
        var cursor: Int?
        for _ in 0..<20 {
            guard let page = try? await store.fetchTrash(cursor: cursor) else { break }
            entries += page.entries
            guard let next = page.nextCursor else { break }
            cursor = next
        }
        trash = entries
    }
}

/// Home's card treatment for one row of a Search list.
private struct SearchCard: ViewModifier {
    let i: Int
    let of: Int

    func body(content: Content) -> some View {
        content
            .listRowInsets(
                EdgeInsets(top: Space.inner, leading: Space.gutter, bottom: Space.inner, trailing: Space.gutter))
            .modifier(HomeCard(slot: CardSlot.at(i, of: of), lifted: false, separator: i < of - 1))
    }
}

/// A row in Search: a name, and the trail above it.
private struct PlaceRow: View {
    let name: Text
    let trail: String
    /// Recently visited's check: this place has nothing left in it.
    let finished: Bool
    /// A done match, dimmed and struck through at the end of its group.
    let struck: Bool
    /// A match rather than a place in Recently visited.
    var matched = false
    let onOpen: () -> Void

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // `PinnedTaskRow`'s two lines, so a place reads the same here as a
        // pin does on Home.
        Button(action: onOpen) {
            HStack(spacing: 6) {
                VStack(alignment: .leading, spacing: 1) {
                    name
                        .font(.body.weight(.medium))
                        .foregroundStyle(finished || struck ? .secondary : .primary)
                        .strikethrough(struck)
                        // Two lines for a match, so the matched word is not
                        // cut off the end of a long task.
                        .lineLimit(struck || matched || typeSize.isAccessibilitySize ? 2 : 1)
                    Text(trail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                if finished {
                    Image(systemName: "checkmark")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Color.done)
                        .accessibilityLabel("Finished")
                }
            }
            .frame(minHeight: Space.tap, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(struck ? "Done" : "")
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

    @Environment(\.dynamicTypeSize) private var typeSize

    /// Two lines at the accessibility sizes, where one held "Project…" and the
    /// row's width can fit no more. One everywhere else, so a long name
    /// does not make its row taller than the rest.
    private var nameLines: Int { typeSize.isAccessibilitySize ? 2 : 1 }

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
                            .lineLimit(nameLines)
                    }
                    if !stacked {
                        Spacer(minLength: 8)
                        count
                    }
                }

                if stacked {
                    HStack(spacing: 8) {
                        bar
                        count
                    }
                } else {
                    bar
                }
            }
        // The three row kinds hold different things and so come out different
        // heights on content alone. A shared minimum levels them and gives each
        // one a full tap target; `maxHeight: .infinity` lets a row that needs
        // more still take it.
        .frame(minHeight: Space.tap, alignment: .leading)
        .contentShape(Rectangle())
    }

    /// The count moves down beside the bar at the accessibility sizes. Beside
    /// the name it took a third of the row there, and the name got what was
    /// left.
    private var stacked: Bool { typeSize.isAccessibilitySize }

    private var count: some View {
        Text(complete ? "All done" : "\(progress.done)/\(progress.total)")
            .font(.caption.monospacedDigit())
            .foregroundStyle(
                complete ? AnyShapeStyle(Color.done) : AnyShapeStyle(.secondary))
            .fixedSize()
    }

    private var bar: some View {
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
