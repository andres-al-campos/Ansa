/// The tree, as a flat array of nodes with parent pointers.
///
/// A port of `shared/tree.ts`. The two must agree: this and the TypeScript are
/// separate implementations of one model, and a client that computes `indent`
/// differently from the server corrupts the tree rather than merely looking
/// wrong. The test suite is the port of `shared/tree.test.ts` for that reason —
/// it is the specification, not a safety net.
///
/// Flat is deliberate, as in the original: this shape *is* a database table, and
/// depth, lineage and progress are derived by walking rather than stored, so
/// re-parenting can't leave a stale field behind.

import Foundation

public typealias NodeId = String

public struct Node: Codable, Equatable, Sendable, Identifiable {
    public var id: NodeId
    /// nil for a root. Each project is its own root.
    public var parentId: NodeId?
    public var text: String
    public var done: Bool
    /// sibling sequence within the same parent
    public var order: Int
    /// folded in place — a view concern, but persisted so it survives reload
    public var collapsed: Bool
    /// favourited to the top of the projects list. Only meaningful on a root.
    public var pinned: Bool?
    /// when this project was last opened, so Recents can sort by it. Root-only.
    public var lastOpenedAt: Double?
    public var createdAt: Double

    /// `parentId` is encoded as an explicit null on a root, where the other
    /// optionals are omitted when unset.
    ///
    /// Not a style choice — the two mean different things to the server. A root
    /// *has* a parent field whose value is null (that is what makes it a root,
    /// and the SQL column is there), while `pinned` and `lastOpenedAt` unset are
    /// genuinely absent; treeStore.ts omits lastOpenedAt rather than sending
    /// null. Swift's synthesised encoder skips every nil, so without this a tree
    /// posted from the phone would arrive with no parentId on any root.
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(parentId, forKey: .parentId)  // null when nil, deliberately
        try c.encode(text, forKey: .text)
        try c.encode(done, forKey: .done)
        try c.encode(order, forKey: .order)
        try c.encode(collapsed, forKey: .collapsed)
        try c.encodeIfPresent(pinned, forKey: .pinned)
        try c.encodeIfPresent(lastOpenedAt, forKey: .lastOpenedAt)
        try c.encode(createdAt, forKey: .createdAt)
    }

    public init(
        id: NodeId,
        parentId: NodeId? = nil,
        text: String,
        done: Bool = false,
        order: Int,
        collapsed: Bool = false,
        pinned: Bool? = nil,
        lastOpenedAt: Double? = nil,
        createdAt: Double = 0
    ) {
        self.id = id
        self.parentId = parentId
        self.text = text
        self.done = done
        self.order = order
        self.collapsed = collapsed
        self.pinned = pinned
        self.lastOpenedAt = lastOpenedAt
        self.createdAt = createdAt
    }
}

public typealias Tree = [Node]

// `order` and `createdAt` are Int and Double against the same JSON numbers the
// web client writes. `order` is a sibling index and always integral; timestamps
// are `Date.now()` milliseconds, which exceed Int32 and are fractional in
// principle, so they stay Double to round-trip unchanged.

// MARK: - Structure

public enum TreeOps {

    /// Direct children of `parentId`, in the tree's own manual order.
    public static func childrenOf(_ tree: Tree, _ parentId: NodeId?) -> [Node] {
        tree.filter { $0.parentId == parentId }.sorted { $0.order < $1.order }
    }

    /// The projects — every node without a parent.
    public static func roots(_ tree: Tree) -> [Node] {
        childrenOf(tree, nil)
    }

    public static func byId(_ tree: Tree, _ id: NodeId) -> Node? {
        tree.first { $0.id == id }
    }

    /// True when `id` has no children.
    public static func isLeaf(_ tree: Tree, _ id: NodeId) -> Bool {
        !tree.contains { $0.parentId == id }
    }

    /// Root-first path down to `id`, inclusive.
    ///
    /// Walks up by parent pointer and reverses. The visited set is what keeps
    /// this total: a cycle would otherwise spin forever, and while `invalidTree`
    /// rejects cycles at the boundary, this is called on trees already in hand.
    public static func lineageOf(_ tree: Tree, _ id: NodeId) -> [Node] {
        var out: [Node] = []
        var seen: Set<NodeId> = []
        var cursor: NodeId? = id
        while let current = cursor, !seen.contains(current), let node = byId(tree, current) {
            seen.insert(current)
            out.append(node)
            cursor = node.parentId
        }
        return out.reversed()
    }

    /// Everything strictly beneath `id`, depth-first in manual order.
    ///
    /// Excludes `id` itself, matching the TypeScript: callers use this for "the
    /// subtree that travels with a node", where including the node would make
    /// removeNode and the drag preview both count it twice. Pass nil for the
    /// whole tree.
    public static func subtreeOf(_ tree: Tree, _ id: NodeId?) -> [Node] {
        var out: [Node] = []
        func walk(_ parentId: NodeId?) {
            for child in childrenOf(tree, parentId) {
                out.append(child)
                walk(child.id)
            }
        }
        walk(id)
        return out
    }

    /// The leaves under `id` — the actual units of work, flattened.
    public static func leavesUnder(_ tree: Tree, _ id: NodeId?) -> [Node] {
        subtreeOf(tree, id).filter { isLeaf(tree, $0.id) }
    }

    /// True when `maybeAncestor` is at or above `id` — used to block cyclic moves.
    public static func isAncestor(_ tree: Tree, _ maybeAncestor: NodeId, _ id: NodeId) -> Bool {
        lineageOf(tree, id).contains { $0.id == maybeAncestor }
    }

    // MARK: - Progress

    public struct Progress: Equatable, Sendable {
        public let done: Int
        public let total: Int
        public let pct: Int
    }

    /// Leaf-weighted progress for `id`.
    ///
    /// Counting leaves rather than direct children is the whole point: a project
    /// whose one child is an unfinished parent should not read 0% when four of
    /// its five grandchildren are done. A node with no leaves under it counts as
    /// one unit of itself, so a bare task still reads 0% or 100%.
    public static func progressOf(_ tree: Tree, _ id: NodeId) -> Progress {
        let leaves = leavesUnder(tree, id)
        if leaves.isEmpty {
            let done = byId(tree, id)?.done == true ? 1 : 0
            return Progress(done: done, total: 1, pct: done * 100)
        }
        let done = leaves.filter(\.done).count
        let pct = Int((Double(done) / Double(leaves.count) * 100).rounded())
        return Progress(done: done, total: leaves.count, pct: pct)
    }

    /// Progress across a whole scope: every leaf under `scope`, or every leaf
    /// in the tree when it is nil.
    ///
    /// Distinct from `progressOf`, which answers for one node. This is the
    /// figure the view shows in its header — the web app has shown one bar per
    /// scope rather than a count per row since the beginning, and nil here means
    /// there is nothing to report rather than 0%.
    public static func scopeProgress(_ tree: Tree, _ scope: NodeId?) -> Progress? {
        let leaves =
            scope.map { leavesUnder(tree, $0) }
            ?? childrenOf(tree, nil).flatMap { leavesUnder(tree, $0.id) }
        guard !leaves.isEmpty else { return nil }
        let done = leaves.filter(\.done).count
        let pct = Int((Double(done) / Double(leaves.count) * 100).rounded())
        return Progress(done: done, total: leaves.count, pct: pct)
    }

    // MARK: - Mutation

    /// Tick or untick `id`, cascading down the subtree and up the ancestors.
    ///
    /// Returns the ids that *became* done on the way up, so the UI can celebrate
    /// a parent finishing. The upward walk also un-completes: unticking one
    /// grandchild has to re-open every ancestor, or the tree claims work is
    /// finished that isn't.
    public static func setDone(
        _ tree: Tree, _ id: NodeId, _ done: Bool
    ) -> (tree: Tree, completed: [NodeId]) {
        var next = tree
        guard let targetIndex = next.firstIndex(where: { $0.id == id }) else {
            return (next, [])
        }
        next[targetIndex].done = done

        // down
        for descendant in subtreeOf(next, id) {
            if let i = next.firstIndex(where: { $0.id == descendant.id }) {
                next[i].done = done
            }
        }

        // up
        var completed: [NodeId] = []
        var parentId = next[targetIndex].parentId
        while let currentId = parentId,
              let parentIndex = next.firstIndex(where: { $0.id == currentId }) {
            let kids = childrenOf(next, currentId)
            let all = !kids.isEmpty && kids.allSatisfy(\.done)
            if all && !next[parentIndex].done {
                next[parentIndex].done = true
                completed.append(currentId)
            } else if !all && next[parentIndex].done {
                next[parentIndex].done = false
            }
            parentId = next[parentIndex].parentId
        }

        return (next, completed)
    }

    /// A nested outline to graft in one call.
    public struct SubtreeSpec: Sendable, Equatable, Codable {
        public let text: String
        public let children: [SubtreeSpec]
        public init(text: String, children: [SubtreeSpec] = []) {
            self.text = text
            self.children = children
        }
    }

    public static func newId() -> NodeId { UUID().uuidString }

    /// Append a nested subtree under `parentId` (nil for a new root).
    ///
    /// `withIds` lets a replayed op name every node exactly as the client that
    /// made it did, taken in the same depth-first order `ids` is returned in;
    /// running past the end falls back to minting.
    @discardableResult
    public static func addSubtree(
        _ tree: Tree,
        _ parentId: NodeId?,
        _ nodes: [SubtreeSpec],
        withIds: [NodeId]? = nil,
        now: Double = Date().timeIntervalSince1970 * 1000
    ) -> (tree: Tree, ids: [NodeId]) {
        var added: [Node] = []
        var ids: [NodeId] = []
        var nextGiven = 0

        func walk(_ pid: NodeId?, _ specs: [SubtreeSpec]) {
            // Land after every existing sibling: start past the highest order
            // already in use under this parent (whether it was there before or
            // added just now), so the graft appends even when the existing
            // orders are sparse.
            let siblings = childrenOf(tree, pid) + added.filter { $0.parentId == pid }
            let start = siblings.reduce(0) { max($0, $1.order + 1) }
            for (i, spec) in specs.enumerated() {
                let id: NodeId
                if let given = withIds, nextGiven < given.count {
                    id = given[nextGiven]
                    nextGiven += 1
                } else {
                    id = newId()
                }
                let node = Node(
                    id: id, parentId: pid, text: spec.text, done: false,
                    order: start + i, collapsed: false, createdAt: now
                )
                added.append(node)
                ids.append(node.id)
                if !spec.children.isEmpty { walk(node.id, spec.children) }
            }
        }

        walk(parentId, nodes)
        return (tree + added, ids)
    }

    /// Append one child. A single task is just a subtree of one node.
    @discardableResult
    public static func addChild(
        _ tree: Tree,
        _ parentId: NodeId?,
        _ text: String,
        id: NodeId? = nil,
        now: Double = Date().timeIntervalSince1970 * 1000
    ) -> (tree: Tree, id: NodeId) {
        let result = addSubtree(
            tree, parentId, [SubtreeSpec(text: text)],
            withIds: id.map { [$0] }, now: now
        )
        return (result.tree, result.ids[0])
    }

    /// Remove `id` and everything under it.
    public static func removeNode(_ tree: Tree, _ id: NodeId) -> Tree {
        var doomed: Set<NodeId> = [id]
        for node in subtreeOf(tree, id) { doomed.insert(node.id) }
        return tree.filter { !doomed.contains($0.id) }
    }

    /// What leaving an edited row should do — nothing, a rename, or a delete.
    ///
    /// Ports `commitEditEdit` from `src/edits.ts`, and the empty case is the
    /// reason it is worth sharing rather than reimplementing. An emptied row is
    /// a deletion, which is how outliners behave, and that has to fire even when
    /// the stored text was *already* empty: a row created and left without
    /// typing is exactly that case, and treating "empty and unchanged" as a
    /// no-op would strand it on screen forever.
    ///
    /// An unchanged non-empty row writes nothing, so leaving a row you only
    /// looked at does not put an op on the wire.
    public static func commitEdit(_ tree: Tree, _ id: NodeId, _ text: String) -> Op? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            guard byId(tree, id) != nil else { return nil }
            return .removeNode(id: id)
        }
        if byId(tree, id)?.text == trimmed { return nil }
        return .setText(id: id, text: trimmed)
    }

    public static func setText(_ tree: Tree, _ id: NodeId, _ text: String) -> Tree {
        tree.map { node in
            guard node.id == id else { return node }
            var n = node
            n.text = text
            return n
        }
    }

    public static func toggleCollapsed(_ tree: Tree, _ id: NodeId) -> Tree {
        tree.map { node in
            guard node.id == id else { return node }
            var n = node
            n.collapsed.toggle()
            return n
        }
    }

    public static func setPinned(_ tree: Tree, _ id: NodeId, _ pinned: Bool) -> Tree {
        tree.map { node in
            guard node.id == id else { return node }
            var n = node
            n.pinned = pinned
            return n
        }
    }

    /// Stamp a project as just-opened, so Recents can sort by last visit.
    public static func markOpened(_ tree: Tree, _ id: NodeId, at: Double) -> Tree {
        tree.map { node in
            guard node.id == id else { return node }
            var n = node
            n.lastOpenedAt = at
            return n
        }
    }

    /// Where the zoom should point after the tree changed underneath it.
    ///
    /// Returns the scope unchanged while it still resolves, which is every
    /// ordinary edit. It only does work when the node being viewed has gone —
    /// deleted on another device, or by an op that arrived over the socket —
    /// and the alternative is a screen showing an empty list under a title for
    /// something that no longer exists.
    ///
    /// The fallback walks the lineage the node had in the tree it was *last
    /// seen in*, because a deleted node has no ancestors in the new tree to
    /// walk. That lineage is why `was` is a parameter: the new tree alone
    /// cannot say where the user was standing. The first ancestor that
    /// survived wins; nil means none did, which lands on the project list.
    ///
    /// - Parameters:
    ///   - scope: the node currently zoomed into, nil for the project list.
    ///   - was: the tree the scope was resolving against a moment ago.
    ///   - now: the tree that just arrived.
    public static func survivingScope(
        _ scope: NodeId?, was: Tree, now: Tree
    ) -> NodeId? {
        guard let scope else { return nil }
        if byId(now, scope) != nil { return scope }
        // `lineageOf` is root-first, so walk it backwards to prefer the
        // closest surviving ancestor over the outermost one — landing the
        // user one level out, not all the way at the top.
        for ancestor in lineageOf(was, scope).reversed() where ancestor.id != scope {
            if byId(now, ancestor.id) != nil { return ancestor.id }
        }
        return nil
    }

    /// Where to land on open: the project last worked in, or nil for the home
    /// list. The port of `resumeScope` — see the TypeScript for why it is
    /// derived from `lastOpenedAt` rather than stored per device.
    public static func resumeScope(_ tree: Tree) -> NodeId? {
        var best: Node?
        for root in roots(tree) {
            guard let stamp = root.lastOpenedAt else { continue }
            if best == nil || stamp > (best?.lastOpenedAt ?? 0) { best = root }
        }
        return best?.id
    }
}
