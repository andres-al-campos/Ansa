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
    public static func dragScroll(
        y: Double,
        top: Double,
        bottom: Double,
        boxes: [RowBox],
        zone: Double = 64
    ) -> ScrollStep {
        guard !boxes.isEmpty else { return .none }

        if y < top + zone {
            // The first row not clipped by the top edge; the one before it is
            // what we want on screen next.
            guard let i = boxes.firstIndex(where: { $0.top >= top }), i > 0 else { return .none }
            return .up(boxes[i - 1].id)
        }
        if y > bottom - zone {
            guard let i = boxes.lastIndex(where: { $0.bottom <= bottom }),
                  i + 1 < boxes.count else { return .none }
            return .down(boxes[i + 1].id)
        }
        return .none
    }
}
