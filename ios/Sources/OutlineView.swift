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
                // Capture sits at the top rather than at the end of the list.
                // Workflowy appends at the bottom, which is right for writing an
                // outline in order and wrong for the case this app exists for:
                // catching an idea while away from the desk, where the field has
                // to be reachable without scrolling anywhere first.
                captureField

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
                            progress: TreeOps.progressOf(tree, row.node.id),
                            hasChildren: !TreeOps.isLeaf(tree, row.node.id),
                            onToggleDone: { apply(.setDone(id: row.node.id, done: !row.node.done)) },
                            onZoom: { scope = row.node.id },
                            onCollapse: { apply(.toggleCollapsed(id: row.node.id)) })
                            .swipeToNest(
                                canIndent: TreeOps.canIndent(tree, row.node.id),
                                canOutdent: TreeOps.canOutdent(tree, row.node.id),
                                onIndent: { indent(row.node.id) },
                                onOutdent: { outdent(row.node.id) },
                                onDragging: { dragging = $0 })
                    }
                    .onDelete(perform: delete)
                }
                .listStyle(.plain)
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

    private func indent(_ id: NodeId) {
        if let op = TreeOps.indentOp(tree, id) { apply(op) }
    }

    private func outdent(_ id: NodeId) {
        if let op = TreeOps.outdentOp(tree, id) { apply(op) }
    }

    private func delete(at offsets: IndexSet) {
        for index in offsets { apply(.removeNode(id: rows[index].node.id)) }
    }

    private func zoomOut() {
        scope = scope.flatMap { TreeOps.byId(tree, $0)?.parentId }
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

/// One row: bullet, text, and the progress of whatever hangs beneath it.
private struct OutlineRow: View {
    let node: Node
    let depth: Int
    let progress: TreeOps.Progress
    let hasChildren: Bool
    let onToggleDone: () -> Void
    let onZoom: () -> Void
    let onCollapse: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Button(action: onToggleDone) {
                Image(systemName: node.done ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(node.done ? AnyShapeStyle(.secondary) : AnyShapeStyle(.tint))
                    .frame(width: 32, height: 40)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            // Tapping the bullet zooms, the way Workflowy does. A parent's
            // bullet also carries the disclosure, so folding and zooming are
            // distinct gestures on the same row rather than a mode.
            Button(action: onZoom) {
                Image(systemName: hasChildren ? "circle.fill" : "circle")
                    .font(.system(size: hasChildren ? 8 : 5))
                    .foregroundStyle(.secondary)
                    // The dot is 8pt; the tap target has to be a finger wide
                    // regardless, so the frame is padded out to it rather than
                    // drawn larger.
                    .frame(width: 32, height: 40)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Text(node.text)
                .strikethrough(node.done)
                .foregroundStyle(node.done ? .secondary : .primary)

            Spacer()

            if hasChildren {
                Text("\(progress.done)/\(progress.total)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                Button(action: onCollapse) {
                    Image(systemName: node.collapsed ? "chevron.right" : "chevron.down")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .frame(width: 32, height: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.leading, CGFloat(depth) * 18)
        // No `.contentShape(Rectangle())` here. It makes the whole row a single
        // hit-test target, which swallows taps before they reach the checkbox,
        // the bullet and the chevron — three separate targets is the point of
        // the row. Add it only alongside a row-level tap action, never on its
        // own.
    }
}
