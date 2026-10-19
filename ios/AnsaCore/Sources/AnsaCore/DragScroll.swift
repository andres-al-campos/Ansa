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

    /// How deep the edge band reaches, in points. Small, because the band is
    /// where a held row can start scrolling the list, and at 64 a row picked
    /// up above the bottom buttons was already in it. (2026-10-19)
    public static let edgeBand: Double = 24

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
        zone: Double = edgeBand
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

/// When a drag in the edge band may scroll, and how fast.
///
/// Two rules, both so the list never moves before you mean it to:
///
/// - Enter-only. A drag that starts in the band does not scroll until the
///   finger has been outside it. Picking a row up near the bottom used to set
///   the list running to the end, with the finger never having moved.
/// - A ramp. Each entry starts at `slowest` rows a second and reaches `fastest`
///   after `rampSeconds`, so a finger that brushes the band nudges the list
///   rather than sending it off.
///
/// Fed every tick of a fast clock; `step` says whether to scroll on this one.
public struct EdgeScrollPace: Sendable {
    public static let slowest = 2.0
    public static let fastest = 7.0
    public static let rampSeconds = 1.0

    private var armed = false
    private var enteredAt: Double?
    private var lastStep: Double?

    public init() {}

    /// Rows a second, this long after entering the band.
    public static func rate(after seconds: Double) -> Double {
        let t = min(max(seconds / rampSeconds, 0), 1)
        return slowest + (fastest - slowest) * t
    }

    /// For a tick at `now` (seconds) where `dragScroll` said `step`: the
    /// duration to animate a one-row scroll over, or nil for no scroll now.
    public mutating func step(_ step: TreeOps.ScrollStep, at now: Double) -> Double? {
        guard step != .none else {
            armed = true
            enteredAt = nil
            lastStep = nil
            return nil
        }
        guard armed else { return nil }
        guard let entered = enteredAt, let last = lastStep else {
            enteredAt = now
            lastStep = now
            return 1 / Self.slowest
        }
        let interval = 1 / Self.rate(after: now - entered)
        guard now - last >= interval else { return nil }
        lastStep = now
        return interval
    }
}
