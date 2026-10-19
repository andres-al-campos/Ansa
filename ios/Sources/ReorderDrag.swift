import AnsaCore
import SwiftUI

/// The press-and-carry-a-row-to-a-new-parent gesture: its state, and the
/// geometry it reads. Not the swipe, which lives in `RowSwipeView`, and not the
/// back swipe — a row has three drags on it, so this one is named for what it
/// does.
///
/// State and geometry only. Anything needing the tree — what a drop would do,
/// whether a row can accept one — stays in the view, so this type never has to
/// know what a drag means.
///
/// Main-actor because every part of it is, which is what lets the timer closure
/// hop back to that actor rather than capturing view state into a `@Sendable`
/// closure.
@MainActor
@Observable
final class ReorderDrag {
    /// The row in flight, or nil when no drag is armed.
    private(set) var dragging: NodeId?
    /// Where the finger is, in global space.
    private(set) var point: CGPoint = .zero
    /// Where the row would land if released now.
    var target: TreeOps.DropTarget?

    /// Row frames in global space, keyed by id, refreshed as rows lay out.
    ///
    /// Only the rows `List` has rendered: it recycles cells, so this is a
    /// window onto the visible tree rather than the whole of it. Every reader
    /// has to treat a missing id as "not measured yet" rather than "not there".
    var frames: [NodeId: CGRect] = [:]
    /// The list's origin, for rebasing a global touch onto the rows.
    var origin: CGPoint = .zero
    /// The list's bounds, so a drag can tell how close the finger is to an edge.
    var bounds: CGRect = .zero

    /// When the last drag ended. Read by `justEnded`.
    private var endedAt: Date?

    /// A drag finished a moment ago, so a tap arriving now is its release.
    ///
    /// The row's label is a Button and the drag is a `.simultaneousGesture`, so
    /// lifting the finger after a drop also completes the tap and the row
    /// opened for rename the instant it landed.
    ///
    /// Time rather than a flag cleared on the next tap: a drop over empty space
    /// fires no Button, and a flag left standing would swallow the next real
    /// tap instead.
    var justEnded: Bool {
        guard let endedAt else { return false }
        return Date().timeIntervalSince(endedAt) < 0.3
    }

    private var scroller: Task<Void, Never>?
    /// How far the edge-scroll has walked, across ticks. See `startScrolling`.
    private var scrollCursor: Int?

    /// Whether a drag is live. Cheaper to read than unwrapping `dragging`, and
    /// it is what the busy flag and the row's fade both actually ask.
    var isActive: Bool { dragging != nil }

    /// The rows' shared left edge in global space. The indent is padding
    /// *inside* the row, so every frame starts at the list's own inset whatever
    /// its depth.
    var rowsLeft: CGFloat { frames.values.map(\.minX).min() ?? 0 }

    /// Row boxes in visual order, from the measured frames. Measured rather
    /// than derived from a uniform height: a row whose text wraps is taller, and
    /// the band arithmetic splits each row into quarters.
    func boxes(order: [NodeId]) -> [TreeOps.RowBox] {
        order.compactMap { id in
            guard let f = frames[id] else { return nil }
            return .init(id: id, top: f.minY, height: f.height)
        }
    }

    func begin(_ id: NodeId) {
        dragging = id
        target = nil
        endedAt = nil
    }

    func moved(to p: CGPoint) {
        point = p
    }

    /// Clear every piece of one drag together. The caller applies the drop
    /// first — this only takes the state down.
    func end() {
        stopScrolling()
        dragging = nil
        target = nil
        endedAt = Date()
    }

    // MARK: - Edge scrolling

    /// Start the edge-scroll tick for the life of this drag.
    ///
    /// A loop of its own rather than work inside the move handler, because the gesture
    /// only reports when the finger *moves* — and holding still at the edge is
    /// exactly how this is used. Driving it from move events would mean the
    /// list scrolled only while the finger jittered.
    ///
    /// The tick walks a cursor along the rows rather than re-deriving the edge
    /// row each time. Either reason alone stalls the scroll: the frames refresh
    /// only on the next layout pass, so asking again within a tick returns the
    /// row just scrolled to; and `scrollTo` moves only far enough to bring a row
    /// into view, so a target one place beyond the edge yields a few pixels.
    ///
    /// - Parameters:
    ///   - order: every visible row, in visual order. Re-read each tick, since
    ///     the tree can change under a drag.
    ///   - onScroll: re-run the hit-test. The rows moved under a finger that
    ///     did not, so the target on screen is about to be wrong, and the move
    ///     handler only fires on movement.
    func startScrolling(
        _ proxy: ScrollViewProxy,
        order: @escaping () -> [NodeId],
        onScroll: @escaping () -> Void
    ) {
        stopScrolling()
        // Held on the instance rather than captured, so each tick reads where
        // the last one left off.
        scrollCursor = nil
        // ~7 rows a second at a full hold. Fast enough to cross a long tree
        // without the drag feeling stuck, slow enough to stop on a chosen row.
        //
        // A main-actor task, not a `Timer`: the timer's callback is `@Sendable`,
        // so the proxy and closures it captured were warnings the compiler
        // could not see past, though it only ever fired on the main thread.
        scroller = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(140))
                guard !Task.isCancelled, let self, self.isActive else { return }
                self.tick(proxy, order: order, onScroll: onScroll)
            }
        }
    }

    /// One edge-scroll step: where the finger is, which row is next, scroll to
    /// it, and re-run the hit-test.
    private func tick(
        _ proxy: ScrollViewProxy,
        order: () -> [NodeId],
        onScroll: () -> Void
    ) {
            let order = order()
            let step = TreeOps.dragScroll(
                y: Double(self.point.y),
                top: Double(self.bounds.minY),
                bottom: Double(self.bounds.maxY),
                order: order,
                boxes: self.boxes(order: order))

            switch step {
            case .none:
                // Out of the edge band: the next entry starts fresh from
                // wherever the list actually sits.
                scrollCursor = nil
            case .up(let id), .down(let id):
                let goingUp = { if case .up = step { return true } else { return false } }()
                // First tick of a run seeds from the measured edge; later ticks
                // carry on from where this one left off, which is the only
                // reading not invalidated by the scroll it just caused.
                guard let from = scrollCursor ?? order.firstIndex(of: id) else { return }
                let next = goingUp ? from - 1 : from + 1
                guard order.indices.contains(next) else { return }
                scrollCursor = next
                withAnimation(.linear(duration: 0.14)) {
                    proxy.scrollTo(order[next], anchor: goingUp ? .top : .bottom)
                }
                onScroll()
            }
    }

    func stopScrolling() {
        scroller?.cancel()
        scroller = nil
    }
}
