import AnsaCore
import SwiftUI

/// The outline, Workflowy-style: tap a bullet to zoom into that node, and the
/// breadcrumb walks back out.
///
/// This first cut runs against a local in-memory tree with no server behind it.
/// The point is to get the model, the project and the simulator agreeing before
/// any of the sync layer exists — if the rows render and the ops apply here,
/// every later problem is a networking problem rather than a model one.
struct OutlineView: View {
    @State private var tree: Tree = sampleTree()
    @State private var scope: NodeId?
    @State private var draft = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Capture sits at the top rather than at the end of the list.
                // Workflowy appends at the bottom, which is right for writing an
                // outline in order and wrong for the case this app exists for:
                // catching an idea while away from the desk, where the field has
                // to be reachable without scrolling anywhere first.
                captureField

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
                    }
                    .onDelete(perform: delete)
                }
                .listStyle(.plain)
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

    private var captureField: some View {
        HStack {
            TextField("Add a task", text: $draft)
                .textFieldStyle(.plain)
                .submitLabel(.done)
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

    /// Every edit goes through `applyOp`, even with no server attached.
    ///
    /// Nothing here mutates the tree directly. That is what makes the sync layer
    /// a later addition rather than a rewrite: when it lands, this same call
    /// also hands the op to the queue, and the local result is already the one
    /// the server will compute.
    private func apply(_ op: Op) {
        tree = TreeOps.applyOp(tree, op).tree
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

/// Stand-in data until the sync layer lands. Deliberately a real nested tree, so
/// depth, folding and leaf-weighted progress are all exercised on first run.
private func sampleTree() -> Tree {
    let spec: [(NodeId, NodeId?, String, Bool)] = [
        ("morning", nil, "This morning", false),
        ("m1", "morning", "Water the plants", true),
        ("m2", "morning", "Reply to the landlord", false),
        ("taxes", nil, "File the tax return", false),
        ("gather", "taxes", "Gather documents", false),
        ("g1", "gather", "Find last year's return", true),
        ("g2", "gather", "Download bank CSV", false),
        ("forms", "taxes", "Fill in the forms", false),
    ]
    var order: [NodeId: Int] = [:]
    return spec.map { item in
        let key = item.1 ?? ""
        let o = order[key] ?? 0
        order[key] = o + 1
        return Node(
            id: item.0, parentId: item.1, text: item.2, done: item.3,
            order: o, collapsed: false, createdAt: 0)
    }
}
