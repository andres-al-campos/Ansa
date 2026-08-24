/// The vertical lines that show which parent a row belongs to.
///
/// A guide is a property of the visible rows, not of the tree: a collapsed
/// parent has no guide because its children are not on screen, and a subtree
/// scrolled half out of view still gets a line for the part that shows. So the
/// input is the same visual row list the hit-test takes, and the output is a
/// range of row indices — the view turns those into pixels, since only it knows
/// how tall each row ended up.
///
/// Depth alone decides the spans. Two rows are under the same parent exactly
/// when the run between them never rises to that parent's depth, which is what
/// makes this a scan rather than a tree walk.

import Foundation

extension TreeOps {

    /// One depth guide: the parent it descends from, and the rows it covers.
    ///
    /// `first` and `last` are indices into the visible row list, inclusive, and
    /// are always descendants — never the parent itself. The line starts below
    /// the parent's bullet rather than at its centre, so it never crosses a
    /// mark; the view applies that offset, because it owns the bullet's size.
    public struct Guide: Equatable, Sendable {
        /// The row the guide hangs from. Its depth is the guide's depth.
        public let parent: NodeId
        public let depth: Int
        public let first: Int
        public let last: Int

        public init(parent: NodeId, depth: Int, first: Int, last: Int) {
            self.parent = parent
            self.depth = depth
            self.first = first
            self.last = last
        }
    }

    /// Every guide the visible rows call for, in row order.
    ///
    /// A parent with children on screen gets one guide reaching to its last
    /// visible descendant. A parent whose children are all collapsed away gets
    /// none — there is nothing for the line to connect it to.
    public static func guides(_ visible: [HitRow]) -> [Guide] {
        var out: [Guide] = []
        for (i, row) in visible.enumerated() {
            // The run of rows deeper than this one, starting at i+1, is exactly
            // this row's visible subtree — it ends at the first row that is not
            // deeper, which is a sibling or an ancestor's next child.
            var last = i
            var j = i + 1
            while j < visible.count, visible[j].depth > row.depth {
                last = j
                j += 1
            }
            guard last > i else { continue }
            out.append(.init(parent: row.id, depth: row.depth, first: i + 1, last: last))
        }
        return out
    }

    /// Every guide passing through row `i`.
    ///
    /// Per row, because the lines are drawn as one segment inside each row
    /// rather than as a single tall overlay. Segments abut into what reads as a
    /// continuous line, and `List` slides one with its row when the row is
    /// swiped aside — which is the whole reason to draw them this way. An
    /// overlay had to punch a hole in itself to fake that.
    ///
    /// Returns the guides rather than their depths because the view needs more
    /// than the depth — it asks which guide belongs to the lit parent, to draw
    /// the half-segment leaving a highlighted row. `guideDepths` had the right
    /// predicate and the wrong return type, so the view carried its own copy of
    /// the filter and the tested one went unused.
    public static func guidesThrough(_ guides: [Guide], at i: Int) -> [Guide] {
        guides.filter { $0.first <= i && i <= $0.last }
    }

    /// The depths of every guide passing through row `i`.
    public static func guideDepths(_ guides: [Guide], at i: Int) -> [Int] {
        guidesThrough(guides, at: i).map(\.depth)
    }
}