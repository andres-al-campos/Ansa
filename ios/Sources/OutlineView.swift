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
    @State private var dragging = false
    @Environment(\.scenePhase) private var scenePhase

    private var tree: Tree { store.tree }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Scrolls away with the list rather than pinning: it says where
                // you are and how far in, which is read on arrival rather than
                // watched continuously. Pinning both ends squeezed an already
                // short screen.
                if let progress = TreeOps.scopeProgress(tree, scope) {
                    ScopeProgress(progress: progress)
                }

                if !store.live {
                    // Only about receiving. Saying "not saved" here would be a
                    // lie that pushes people into re-typing work that is
                    // already queued and will go out on its own.
                    SyncBanner(
                        text: "Not receiving changes from other devices. Your edits are still saved.")
                }

                List {
                    ForEach(rows, id: \.node.id) { row in
                        OutlineRow(
                            node: row.node,
                            depth: row.depth,
                            hasChildren: !TreeOps.isLeaf(tree, row.node.id),
                            onToggleDone: { apply(.setDone(id: row.node.id, done: !row.node.done)) },
                            onCollapse: { apply(.toggleCollapsed(id: row.node.id)) })
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
            // Two mid-edit states, and the store takes one flag, so they are
            // combined here rather than each calling setBusy on its own — the
            // one that ends first would otherwise clear the other's hold.
            //
            // Typing: the capture field holds a draft the user can see, and
            // adopting a server tree under it is what makes text vanish as it
            // is being written. Dragging: the row would move out from under the
            // finger mid-gesture.
            .onChange(of: capturing || dragging) { _, busy in store.setBusy(busy) }
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

    private var captureField: some View {
        HStack {
            TextField("Add a task", text: $draft)
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
    let onToggleDone: () -> Void
    let onCollapse: () -> Void

    /// One indent step. Small on purpose — depth is read from the guides, and a
    /// wider step costs text width on a screen that has none to spare.
    private static let indent: CGFloat = 18

    var body: some View {
        HStack(spacing: 10) {
            // Square, where the bullet is round. Both marks used to be circles
            // differing by fill and colour — the same two channels that carry
            // *state* — so a ticked box and a collapsed parent's bullet
            // converged on one mark meaning two things in adjacent columns.
            // Shape is categorical: it says what the control is, whatever state
            // it happens to be in, which leaves fill free to mean only "done".
            Button(action: onToggleDone) {
                Checkbox(done: node.done)
                    .frame(width: 32, height: 40)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

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
            .disabled(!hasChildren)

            Text(node.text)
                .strikethrough(node.done)
                .foregroundStyle(node.done ? .secondary : .primary)
                .frame(maxWidth: .infinity, alignment: .leading)
                // Without this the last word runs under the screen edge. The
                // list's own inset is spent on the leading marks, and a row
                // that wraps takes every point it is given.
                .padding(.trailing, 4)
        }
        .padding(.leading, CGFloat(depth) * Self.indent)
        .background(alignment: .leading) { guides }
        // No `.contentShape(Rectangle())` here. It makes the whole row a single
        // hit-test target, which swallows taps before they reach the checkbox
        // and the bullet — separate targets are the point of the row. Add it
        // only alongside a row-level tap action, never on its own.
    }

    /// One vertical hairline per ancestor level, the way the web app draws them.
    ///
    /// Load-bearing rather than decorative: an 18pt step is too small to read as
    /// depth on its own, and rows here wrap to two and three lines, so the left
    /// edge of the text moves more from wrapping than from nesting. The lines
    /// are what actually says how deep a row sits.
    private var guides: some View {
        HStack(spacing: 0) {
            ForEach(0..<depth, id: \.self) { _ in
                // The line sits under the centre of the bullet column one level
                // up, so it points at the parent's mark rather than floating
                // between columns.
                Rectangle()
                    .fill(.quaternary)
                    .frame(width: 1)
                    .frame(width: Self.indent, alignment: .center)
            }
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
