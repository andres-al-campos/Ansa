/// Structural moves and validation — the second half of the `shared/tree.ts`
/// port.
///
/// Split from Tree.swift because these are the functions the sync layer has to
/// get bit-identical: everything here rewrites `order` and `parentId`, so a
/// client that disagrees with the server about where a moved row lands writes an
/// op the server applies somewhere else. The lookups and progress in Tree.swift
/// can be wrong and merely look wrong; these can be wrong and corrupt.
///
/// `moveRow` and `depthAtGap` serve pointer-drag on the web and have no caller
/// on the phone yet. Ported anyway so the Swift and the TypeScript suites stay
/// case-for-case comparable, which is the thing that keeps the two in step.

import Foundation

extension TreeOps {

    // MARK: - Validation

    /// True when `value` is shaped like a Node.
    ///
    /// The Swift decoder already enforces most of this — a missing `done` or a
    /// string `order` throws rather than producing a bad Node — so this exists
    /// for the referential rules in `invalidTree`, which the type system can't
    /// express.
    public static func depthOf(_ tree: Tree, _ id: NodeId) -> Int {
        lineageOf(tree, id).count - 1
    }

    /// Check a decoded tree is usable, naming the first problem, or nil if fine.
    ///
    /// Per-node shape isn't enough. The three referential rules below are what
    /// keep the walks total:
    ///
    ///  - unique ids, or byId returns one node while removeNode drops two;
    ///  - every parentId resolves, or a branch is orphaned out of every view
    ///    while still occupying the table;
    ///  - no parent cycles — the one that actually hangs, since subtreeOf walks
    ///    parent pointers with no visited set.
    public static func invalidTree(_ tree: Tree) -> String? {
        var ids: Set<NodeId> = []
        for node in tree {
            if ids.contains(node.id) { return "duplicate node id: \(node.id)" }
            ids.insert(node.id)
        }
        for node in tree {
            if let parentId = node.parentId, !ids.contains(parentId) {
                return "node \(node.id) has a parentId that doesn't exist: \(parentId)"
            }
        }

        // Walk each node to its root, memoising the ones already proven rooted
        // so this stays linear rather than quadratic down a deep chain.
        var rooted: Set<NodeId> = []
        var parents: [NodeId: NodeId?] = [:]
        for node in tree { parents[node.id] = node.parentId }

        for start in tree {
            var path: [NodeId] = []
            var seen: Set<NodeId> = []
            var cursor: NodeId? = start.id
            while let current = cursor, !rooted.contains(current) {
                if seen.contains(current) { return "node \(current) is its own ancestor" }
                seen.insert(current)
                path.append(current)
                cursor = parents[current] ?? nil
            }
            for id in path { rooted.insert(id) }
        }
        return nil
    }

    // MARK: - Projects

    /// Projects for the sidebar, split in two. Both follow the tree's own manual
    /// `order`, and the two are disjoint — a pinned project shows only under
    /// Pinned.
    public static func projectSections(_ tree: Tree) -> (pinned: [Node], unpinned: [Node]) {
        let rs = roots(tree)
        return (rs.filter { $0.pinned == true }, rs.filter { $0.pinned != true })
    }

    /// Flat list of every project — pinned first, then the rest in manual order.
    public static func projectList(_ tree: Tree) -> [Node] {
        let sections = projectSections(tree)
        return sections.pinned + sections.unpinned
    }

    // MARK: - Moves

    /// Move a node to a new parent at `index` among that parent's children, and
    /// renumber both affected sibling lists to a dense 0..n-1 sequence. Every
    /// other structural move is a special case of this one.
    ///
    /// A no-op when the target would form a cycle. `index` is clamped, and
    /// measured against the destination list *without* the moved node, so a
    /// same-parent reorder counts slots as you'd expect.
    public static func moveNode(
        _ tree: Tree, _ id: NodeId, _ newParentId: NodeId?, _ index: Int
    ) -> Tree {
        guard let node = byId(tree, id) else { return tree }
        if newParentId == id { return tree }
        if let target = newParentId, isAncestor(tree, id, target) { return tree }

        let dest = childrenOf(tree, newParentId).filter { $0.id != id }
        let at = max(0, min(index, dest.count))
        let ordered = dest[..<at] + [node] + dest[at...]

        // New order for the destination list; the source list closes its gap
        // simply by being renumbered from its own remaining children.
        var destOrder: [NodeId: Int] = [:]
        for (i, n) in ordered.enumerated() { destOrder[n.id] = i }
        var srcOrder: [NodeId: Int] = [:]
        for (i, n) in childrenOf(tree, node.parentId).filter({ $0.id != id }).enumerated() {
            srcOrder[n.id] = i
        }

        return tree.map { n in
            var out = n
            if n.id == id {
                out.parentId = newParentId
                out.order = destOrder[id]!
                return out
            }
            if let o = destOrder[n.id] {
                out.order = o
                return out
            }
            // Only renumber the source list when it's a *different* parent; a
            // same-parent move already covered everyone through destOrder.
            if newParentId != node.parentId, let o = srcOrder[n.id] {
                out.order = o
                return out
            }
            return n
        }
    }

    /// Tab: tuck a node under its preceding sibling, as that sibling's last
    /// child. A no-op for the first child — nothing to nest under.
    public static func indent(_ tree: Tree, _ id: NodeId) -> Tree {
        guard let node = byId(tree, id) else { return tree }
        let siblings = childrenOf(tree, node.parentId)
        guard let i = siblings.firstIndex(where: { $0.id == id }), i > 0 else { return tree }
        let newParent = siblings[i - 1]
        return moveNode(tree, id, newParent.id, childrenOf(tree, newParent.id).count)
    }

    /// The `moveNode` op that performs an indent, or nil when it is not legal.
    ///
    /// The wire has `moveNode`, not `indent`, so the destination has to be
    /// resolved somewhere. Doing it here rather than in the UI keeps it beside
    /// `indent` itself — the two derive the same parent and index from the same
    /// rules, and a copy in a view is exactly how they would drift apart. It
    /// also means the server receives an explicit parent and index rather than
    /// re-deriving "one level in" against a tree that may have moved on.
    public static func indentOp(_ tree: Tree, _ id: NodeId) -> Op? {
        guard let node = byId(tree, id) else { return nil }
        let siblings = childrenOf(tree, node.parentId)
        guard let i = siblings.firstIndex(where: { $0.id == id }), i > 0 else { return nil }
        let newParent = siblings[i - 1]
        return .moveNode(
            id: id, parentId: newParent.id, index: childrenOf(tree, newParent.id).count)
    }

    /// The `moveNode` op that performs an outdent, or nil at the root.
    public static func outdentOp(_ tree: Tree, _ id: NodeId) -> Op? {
        guard let node = byId(tree, id), let parentId = node.parentId,
              let parent = byId(tree, parentId) else { return nil }
        let uncles = childrenOf(tree, parent.parentId)
        let parentIndex = uncles.firstIndex { $0.id == parent.id } ?? -1
        return .moveNode(id: id, parentId: parent.parentId, index: parentIndex + 1)
    }

    /// Whether `indent` would actually move this node.
    ///
    /// Defined next to `indent` and in terms of the same condition, so a UI can
    /// offer the gesture exactly when it will work. Asking the move itself
    /// (apply it and compare) would be correct but costs a whole tree copy per
    /// row per frame, which a drag gesture does often enough to notice.
    public static func canIndent(_ tree: Tree, _ id: NodeId) -> Bool {
        guard let node = byId(tree, id) else { return false }
        let siblings = childrenOf(tree, node.parentId)
        guard let i = siblings.firstIndex(where: { $0.id == id }) else { return false }
        return i > 0
    }

    /// Whether `outdent` would actually move this node: false at the root,
    /// where there is no level to pop up to.
    public static func canOutdent(_ tree: Tree, _ id: NodeId) -> Bool {
        byId(tree, id)?.parentId != nil
    }

    /// Shift-Tab: pop a node up a level, landing right after its old parent
    /// among the grandparent's children. A no-op at the root.
    public static func outdent(_ tree: Tree, _ id: NodeId) -> Tree {
        guard let node = byId(tree, id), let parentId = node.parentId,
              let parent = byId(tree, parentId) else { return tree }
        let uncles = childrenOf(tree, parent.parentId)
        let parentIndex = uncles.firstIndex { $0.id == parent.id } ?? -1
        return moveNode(tree, id, parent.parentId, parentIndex + 1)
    }

    /// Nest every following sibling under this node, in order, appended after
    /// any children it already has. The node itself stays put. This is what
    /// Shift-Tab does when a row can't outdent any further: rather than escaping
    /// its level, it pulls the rows below it in as its own subtree.
    public static func adoptFollowing(_ tree: Tree, _ id: NodeId) -> Tree {
        guard let node = byId(tree, id) else { return tree }
        let siblings = childrenOf(tree, node.parentId)
        guard let i = siblings.firstIndex(where: { $0.id == id }) else { return tree }
        let following = siblings[(i + 1)...]
        if following.isEmpty { return tree }
        return following.reduce(tree) { acc, sib in
            moveNode(acc, sib.id, id, childrenOf(acc, id).count)
        }
    }

    /// Move a row one line up or down the *visible* list, the way dragging it
    /// would — crossing into and out of other parents rather than stopping at
    /// the ends of its own sibling list.
    ///
    /// `order` is the flattened visible rows the caller already computes for
    /// rendering. Passing it in is what keeps "one row" honest: a folded subtree
    /// counts as the single line it draws, and hidden rows are never landed on.
    public static func moveRow(
        _ tree: Tree, _ id: NodeId, _ dir: MoveDirection, _ order: [NodeId]
    ) -> Tree {
        guard byId(tree, id) != nil, let i = order.firstIndex(of: id) else { return tree }
        let own = Set(subtreeOf(tree, id).map(\.id))

        if dir == .up {
            // The nearest visible row above that isn't part of what we carry.
            var j = i - 1
            while j >= 0 && own.contains(order[j]) { j -= 1 }
            guard j >= 0, let target = byId(tree, order[j]) else { return tree }
            let sibs = childrenOf(tree, target.parentId).filter { $0.id != id }
            let pos = sibs.firstIndex { $0.id == target.id } ?? -1
            return moveNode(tree, id, target.parentId, pos)
        }

        var j = i + 1
        while j < order.count && own.contains(order[j]) { j += 1 }
        guard j < order.count, let target = byId(tree, order[j]) else { return tree }
        // An open parent's next visible line is its first child, so stepping
        // down onto it means stepping *into* it.
        if !target.collapsed && !childrenOf(tree, target.id).isEmpty {
            return moveNode(tree, id, target.id, 0)
        }
        let sibs = childrenOf(tree, target.parentId).filter { $0.id != id }
        let pos = sibs.firstIndex { $0.id == target.id } ?? -1
        return moveNode(tree, id, target.parentId, pos + 1)
    }

    public enum MoveDirection: String, Sendable { case up, down }
    public enum DropSide: String, Codable, Sendable { case before, after }

    /// The indent level a drop lands at, given the pointer's X and the rows
    /// framing the gap. Clamped to the range `deepestAtGap` allows, and no
    /// shallower than the top of the current scope.
    ///
    /// There is deliberately no floor at the row *below* the gap. That floor
    /// made an in-place outdent impossible: every gap inside a parent has one of
    /// that parent's own children below it, so a child could never reach depth 0
    /// without being dragged past its parent's entire subtree.
    public static func depthAtGap(
        clientX: Double, aboveDepth: Int?, belowDepth: Int?,
        aboveHasChildren: Bool = true, guideX0: Double, indent: Double
    ) -> Int {
        let maxD = deepestAtGap(
            aboveDepth: aboveDepth, belowDepth: belowDepth,
            aboveHasChildren: aboveHasChildren)
        let raw = Int(((clientX - guideX0) / indent).rounded())
        return max(0, min(maxD, raw))
    }

    /// The deepest level a gap will accept.
    ///
    /// One deeper than the row above only when that row *already* has children.
    /// Under a leaf, becoming its child is exclusively the `into` drop — drag
    /// onto the row itself. The reason is that on a phone the X axis is read
    /// through a thumb: every extra legal depth in a gap is another 20pt band
    /// to hit, and "child of a leaf" is the one meaning that has an unambiguous
    /// gesture of its own. Dropping it from the gap costs nothing and makes the
    /// remaining bands wider.
    ///
    /// The shallow end is never restricted — depth 0 is offered at every gap.
    /// That is what makes an outdent reachable in place, and with this rule it
    /// is also the *only* way to outdent, so the drop indicator has to show
    /// where the shallow end is and not just the deep one.
    public static func deepestAtGap(
        aboveDepth: Int?, belowDepth: Int?, aboveHasChildren: Bool = true
    ) -> Int {
        guard let aboveDepth else { return belowDepth ?? 0 }
        return aboveHasChildren ? aboveDepth + 1 : aboveDepth
    }

    /// Resolve a depth-aware drop into a concrete move. `anchorId` is the
    /// visible row on the far side of the gap; `depth` is the scope-relative
    /// indent from `depthAtGap`.
    ///
    /// Walking the anchor's lineage from the scope down gives the chain of
    /// possible parents. A depth past the end of that chain means "nest under
    /// the anchor itself"; otherwise the parent is the ancestor at that depth.
    public static func insertAtDepth(
        _ tree: Tree, _ dragging: NodeId, _ anchorId: NodeId,
        _ depth: Int, _ side: DropSide, _ scope: NodeId?
    ) -> Tree {
        let full = lineageOf(tree, anchorId)
        let scopeIdx = scope.flatMap { s in full.firstIndex { $0.id == s } } ?? -1
        let chain = Array(full[(scopeIdx + 1)...])
        let nestUnderAnchor = depth >= chain.count

        let newParentId: NodeId? =
            nestUnderAnchor ? anchorId : depth == 0 ? scope : chain[depth - 1].id
        let kids = childrenOf(tree, newParentId).filter { $0.id != dragging }

        let index: Int
        if nestUnderAnchor {
            // The gap that produced this drop sits directly under the anchor
            // row, so the row lands at the top of its children — where the
            // indicator was drawn. Appending would drop it past every existing
            // child, which reads as the row jumping on release.
            index = 0
        } else {
            let onPath = chain[depth].id
            let pos = kids.firstIndex { $0.id == onPath } ?? -1
            index = side == .before ? pos : pos + 1
        }
        return moveNode(tree, dragging, newParentId, index)
    }
}
