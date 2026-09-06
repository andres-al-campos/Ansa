/// Where a dragged row would land, given where the finger is.
///
/// The Swift half of `src/dropTarget.ts`. Split out of the view for the same
/// reason it is split out of the component on the web: this is a question, not
/// a step. Tree, visible rows, and a touch point in; a drop target out; nothing
/// mutated. The depth arithmetic is the part of dragging that is easy to get
/// subtly wrong and hard to see going wrong, so it wants tests of its own.
///
/// Boxes are passed in, measured, exactly as `RowHit` carries measured rects on
/// the web — a row whose text wraps is taller than one that does not, and the
/// band arithmetic splits each row into three, so a wrong height puts the
/// `into` band somewhere other than the middle of the row. `rowBoxes` derives
/// them from a uniform height for callers that have one, but the view measures
/// instead and builds `RowBox` values directly.

import Foundation

extension TreeOps {

    /// Where a dragged node lands relative to the row under the finger.
    ///
    /// `return` is the item's own vacated slot — release there to put it back
    /// untouched. `into` nests as the hovered row's first child. `before` and
    /// `after` insert in a gap, where `depth` is the level the finger picked
    /// via its X, so one gap can mean "sibling of the row above", "child of
    /// it", or any shallower ancestor level.
    public enum DropMode: String, Sendable { case before, after, into, `return` }

    /// A resolved drop: which row it anchors to, on which side, and how deep.
    public struct DropTarget: Equatable, Sendable {
        public let id: NodeId
        public let mode: DropMode
        /// For `before`/`after`: the chosen indent level. Nil for the others.
        public let depth: Int?

        public init(id: NodeId, mode: DropMode, depth: Int? = nil) {
            self.id = id
            self.mode = mode
            self.depth = depth
        }
    }

    /// One row as drawn, in visual order — only what the hit-test needs.
    public struct HitRow: Equatable, Sendable {
        public let id: NodeId
        public let depth: Int

        public init(id: NodeId, depth: Int) {
            self.id = id
            self.depth = depth
        }
    }

    /// One row's box in the list's coordinate space.
    public struct RowBox: Equatable, Sendable {
        public let id: NodeId
        public let top: Double
        public let height: Double

        public init(id: NodeId, top: Double, height: Double) {
            self.id = id
            self.top = top
            self.height = height
        }

        var bottom: Double { top + height }
    }

    /// The row boxes for a uniform-height list, in visual order.
    ///
    /// Convenience for the common case; a caller with wrapping rows should
    /// measure instead and build `RowBox` values directly.
    public static func rowBoxes(
        _ visible: [HitRow], rowHeight: Double, listTop: Double = 0
    ) -> [RowBox] {
        visible.enumerated().map { i, row in
            RowBox(id: row.id, top: listTop + Double(i) * rowHeight, height: rowHeight)
        }
    }

    /// Where a row's top band ends and its middle begins, as a fraction of the
    /// row's height. The bottom band mirrors it.
    ///
    /// Three bands: insert above, nest into, insert below. This is the only
    /// number that sets how wide each one is.
    ///
    /// A quarter, which makes the three outcomes equally likely rather than
    /// merely equally sized. A gap is a boundary between two rows, so its band
    /// is the bottom quarter of the row above plus the top quarter of the row
    /// below — half a row's worth of travel, the same as the nest band in the
    /// middle. Splitting a row into even thirds looks fair and is not: it gives
    /// each gap two thirds of a row while nesting keeps one.
    ///
    /// This was briefly 0.35, to widen the gaps. It did the opposite of what it
    /// was reaching for — above a third, so nesting came out the *narrowest* of
    /// the three at about 13pt, which is the wrong band to shrink. The web has
    /// been at a quarter throughout, as is every outliner that does this.
    static let nestBand = 0.25

    /// Resolve a touch point to a drop target: which row, and which of its three
    /// bands — top quarter is the gap above, middle half nests into, bottom
    /// quarter is the gap below.
    ///
    /// Hovering the lifted row's own slot gives `return`, so releasing where you
    /// started changes nothing. Descendants are not drawn mid-drag, so a cycle
    /// cannot arise; the `isAncestor` check is belt and braces for the case
    /// where one is drawn anyway.
    ///
    /// In a gap the finger's X picks the depth, because a gap below a deep row
    /// is genuinely ambiguous — it could mean that row's level, any shallower
    /// ancestor's level, or (when the row above already has children) one
    /// deeper. `depthAtGap` works out the legal range and clamps X into it.
    ///
    /// - Parameters:
    ///   - x: touch X in the list's coordinate space, from the rows' left edge.
    ///   - y: touch Y in the same space.
    ///   - guideX0: X of depth 0, where the nesting guides start.
    ///   - indent: width of one indent step.
    public static func dropTargetAt(
        x: Double,
        y: Double,
        dragging: NodeId,
        tree: Tree,
        visible: [HitRow],
        boxes: [RowBox],
        guideX0: Double,
        indent: Double
    ) -> DropTarget? {
        for box in boxes {
            guard y >= box.top, y <= box.bottom else { continue }
            let id = box.id
            if id == dragging { return DropTarget(id: id, mode: .return) }
            if isAncestor(tree, dragging, id) { return nil }

            let rel = box.height > 0 ? (y - box.top) / box.height : 0
            if rel >= nestBand && rel <= 1 - nestBand {
                return DropTarget(id: id, mode: .into)
            }

            // An insertion gap. Name the rows bounding it: `above` sits just
            // over the gap, `below` just under. The lifted row still holds a
            // slot in `visible`, so skip past it when naming neighbours — its
            // old depth would otherwise bound the drop wrongly.
            let i = visible.firstIndex { $0.id == id } ?? 0
            func prev(_ k: Int) -> HitRow? {
                var j = k
                while j >= 0 {
                    if visible[j].id != dragging { return visible[j] }
                    j -= 1
                }
                return nil
            }
            func next(_ k: Int) -> HitRow? {
                var j = k
                while j < visible.count {
                    if visible[j].id != dragging { return visible[j] }
                    j += 1
                }
                return nil
            }
            let above = rel < nestBand ? prev(i - 1) : prev(i)
            let below = rel < nestBand ? next(i) : next(i + 1)
            // Whether the row above can already take children decides how deep
            // this gap goes — see `deepestAtGap`. The lifted row does not
            // count: it is about to leave, so a parent whose only child is the
            // one in flight is a leaf for the purpose of this drop.
            let aboveHasChildren = above.map { a in
                childrenOf(tree, a.id).contains { $0.id != dragging }
            } ?? true
            let depth = depthAtGap(
                clientX: x,
                aboveDepth: above?.depth,
                belowDepth: below?.depth,
                aboveHasChildren: aboveHasChildren,
                guideX0: guideX0,
                indent: indent)

            // Anchor to the row above the gap, inserting after it. At the very
            // top there is no row above, so anchor before the first row.
            if let above { return DropTarget(id: above.id, mode: .after, depth: depth) }
            guard let below else { return nil }
            return DropTarget(id: below.id, mode: .before, depth: depth)
        }
        return nil
    }

    /// The op a resolved drop should send, or nil when the drop changes nothing.
    ///
    /// Lives here beside `dropTargetAt` for the reason `indentOp` lives beside
    /// `indent`: the wire carries `moveNode` and `insertAtDepth`, and a copy of
    /// this mapping in a view is exactly how the two would drift apart.
    public static func dropOp(
        _ tree: Tree, _ dragging: NodeId, _ target: DropTarget, scope: NodeId?
    ) -> Op? {
        switch target.mode {
        case .return:
            return nil
        case .into:
            return .moveNode(id: dragging, parentId: target.id, index: 0)
        case .before, .after:
            guard let depth = target.depth else { return nil }
            let side: DropSide = target.mode == .before ? .before : .after
            return .insertAtDepth(
                id: dragging, anchorId: target.id, depth: depth, side: side, scope: scope)
        }
    }
}
