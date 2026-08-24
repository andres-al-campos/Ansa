import AnsaCore
import SwiftUI

/// One drag's worth of state, plus the geometry a drag reads.
///
/// Pulled out of `OutlineView` because these pieces are meaningless apart and
/// always change together — `endDrag` clearing them as a unit was the tell. The
/// bugs this session came from two of them disagreeing: `rowFrames` was serving
/// as both "what is on screen" and "what exists", and the frame it held was the
/// row's content box while every reader wanted the whole cell.
///
/// It owns state and geometry only. Anything needing the tree — what a drop
/// would do, whether a row can accept one — stays in the view, so this type
/// never has to know what a drag means.
@Observable
final class DragController {
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

    private var scroller: Timer?

    /// Whether a drag is live. Cheaper to read than unwrapping `dragging`, and
    /// it is what the busy flag and the row's fade both actually ask.
    var isActive: Bool { dragging != nil }

    /// The rows' shared left edge in global space.
    ///
    /// Any row's will do: the indent is padding *inside* the row, so every
    /// frame starts at the list's own inset whatever its depth. Taking the
    /// minimum avoids depending on which row happens to be first.
    var rowsLeft: CGFloat { frames.values.map(\.minX).min() ?? 0 }

    /// Row boxes in visual order, from the measured frames.
    ///
    /// Measured rather than derived from a uniform height, because a row whose
    /// text wraps is taller than one that does not — and the band arithmetic
    /// splits each row into quarters, so a wrong height puts the `into` band in
    /// the wrong place rather than merely off by a little.
    func boxes(order: [NodeId]) -> [TreeOps.RowBox] {
        order.compactMap { id in
            guard let f = frames[id] else { return nil }
            return .init(id: id, top: f.minY, height: f.height)
        }
    }

    func begin(_ id: NodeId) {
        dragging = id
        target = nil
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
    }

    // MARK: - Edge scrolling

    /// Start the edge-scroll tick for the life of this drag.
    ///
    /// A timer rather than work inside the move handler, because the gesture
    /// only reports when the finger *moves* — and holding still at the edge is
    /// exactly how this is used. Driving it from move events would mean the
    /// list scrolled only while the finger jittered.
    ///
    /// The tick walks a cursor along the rows rather than re-deriving the edge
    /// row from the measured frames each time. Two reasons, and either alone
    /// stalls the scroll:
    ///
    /// The frames come from a preference that refreshes on the next layout
    /// pass, so within a tick they still describe the pre-scroll positions —
    /// asking again returns the row just scrolled to, and re-issuing that
    /// scroll does nothing. And `scrollTo` only moves far enough to bring a row
    /// into view, so a target one place beyond the edge is already nearly
    /// visible and yields a few pixels of travel. Together they are a scroll
    /// that creeps a couple of pixels and then stops dead while the timer keeps
    /// running.
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
        var cursor: Int? = nil
        // ~7 rows a second at a full hold. Fast enough to cross a long tree
        // without the drag feeling stuck, slow enough to stop on a chosen row.
        scroller = Timer.scheduledTimer(withTimeInterval: 0.14, repeats: true) { [weak self] _ in
            guard let self, self.isActive else { return }
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
                cursor = nil
            case .up(let id), .down(let id):
                let goingUp = { if case .up = step { return true } else { return false } }()
                // First tick of a run seeds from the measured edge; later ticks
                // carry on from where this one left off, which is the only
                // reading not invalidated by the scroll it just caused.
                guard let from = cursor ?? order.firstIndex(of: id) else { return }
                let next = goingUp ? from - 1 : from + 1
                guard order.indices.contains(next) else { return }
                cursor = next
                withAnimation(.linear(duration: 0.14)) {
                    proxy.scrollTo(order[next], anchor: goingUp ? .top : .bottom)
                }
                onScroll()
            }
        }
    }

    func stopScrolling() {
        scroller?.invalidate()
        scroller = nil
    }
}
