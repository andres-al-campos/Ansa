/// Scrolling the list while a drag is held near its edge.
///
/// Without this a drag can only reach what was already on screen, so moving a
/// row to the far end of a long tree is not a slow gesture — it is an
/// impossible one. The finger holds the row, and the row it would displace is
/// somewhere the finger cannot go.
///
/// What comes back is a row to scroll to, not a pixel delta. On iOS 17 the only
/// lever for a `List` is `scrollTo(id:)`, which takes a row; the coarser unit
/// suits an outline anyway, where the thing being aimed at is always a row.

import Foundation

extension TreeOps {

    /// Which way the list should move, and how urgently.
    public enum ScrollStep: Equatable, Sendable {
        case none
        /// Bring the row this many places beyond the visible edge into view.
        case up(NodeId)
        case down(NodeId)
    }

    /// The row to scroll to for a finger at `y`, or `.none` if it is clear of
    /// both edges.
    ///
    /// `zone` is how deep the edge band reaches. Inside it, the list steps by
    /// one row per call — the caller ticks on a timer, so rate is its business,
    /// not this function's.
    ///
    /// The step is measured from the outermost row that is *fully* visible, not
    /// from the finger. Stepping relative to the finger stalls: the row under a
    /// finger parked in the band is already partly off screen, so scrolling to
    /// it moves nothing and the next tick asks for the same row again.
    ///
    /// `order` is every visible row, `boxes` only the ones currently measured.
    /// They are separate arguments because they are different sets: `boxes`
    /// comes from a SwiftUI preference, which reports only rows `List` has
    /// rendered, and `List` recycles cells as it scrolls. Stepping within
    /// `boxes` therefore walks off its own end after a screenful — the next row
    /// up is precisely the one that has not been rendered yet — and the scroll
    /// stops dead while the timer keeps ticking. Stepping in `order` always has
    /// somewhere to go.
    public static func dragScroll(
        y: Double,
        top: Double,
        bottom: Double,
        order: [NodeId],
        boxes: [RowBox],
        zone: Double = 64
    ) -> ScrollStep {
        guard !boxes.isEmpty, !order.isEmpty else { return .none }

        if y < top + zone {
            // The topmost row not clipped by the edge, then one place before it
            // in the full list — which is usually not in `boxes` at all.
            guard let edge = boxes.filter({ $0.top >= top }).min(by: { $0.top < $1.top }),
                  let i = order.firstIndex(of: edge.id), i > 0 else { return .none }
            return .up(order[i - 1])
        }
        if y > bottom - zone {
            guard let edge = boxes.filter({ $0.bottom <= bottom }).max(by: { $0.bottom < $1.bottom }),
                  let i = order.firstIndex(of: edge.id), i + 1 < order.count else { return .none }
            return .down(order[i + 1])
        }
        return .none
    }
}
