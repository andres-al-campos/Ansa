import SwiftUI
import UIKit

/// A lift buzz for `List`'s own reorder drag.
///
/// `.onMove` gives no lift callback, and a SwiftUI `LongPressGesture` beside it
/// never fires: `List`'s reorder recognizer claims the press, and
/// `simultaneousGesture` does not share with it. Verified — with `.onMove` on
/// the `ForEach` the SwiftUI gesture is silent, and removing it makes the same
/// gesture fire.
///
/// Adding our own UIKit long press does not work either: the reorder is a drag
/// *lift*, and a drag lift fails a competing long press instead of running
/// beside it. Verified — the added recognizer attaches and never fires.
///
/// So this hooks the lift recognizers the collection view already has. The buzz
/// lands exactly when `List` arms its drag, with no duration to guess at.
///
/// The same hook also reports whether a row is off the ground, via
/// `onDragChanged`, which is what squares the lifted row's corners — that row
/// only, so it reports *which* row rather than just that one is up. There is no
/// one signal for that: `.onMove` fires once, on the drop, and the lift
/// recognizer *ends* the moment the drag session takes over — measured, 763ms
/// into a drag still under the finger. So the carry is two halves. The lift
/// recognizer covers the press, and `UICollectionView.hasActiveDrag` covers the
/// rest; the second turns true in the same frame the first ends.
///
/// `hasActiveDrag` is polled rather than observed: it is a plain getter, not
/// KVO-compliant — verified, an observer on it never fires. The poll runs on a
/// display link and only between the lift and the drop.
struct ListLiftFeedback: UIViewRepresentable {
    /// The row that is off the ground, from the press that arms the lift until
    /// the drop, and nil the rest of the time.
    var onDragChanged: (IndexPath?) -> Void = { _ in }

    /// Marks the collection view we have already hooked, so a redraw does not
    /// add a second target and buzz twice.
    private static let marker = UnsafeRawPointer(bitPattern: 0xA_11F7)!

    func makeCoordinator() -> Coordinator { Coordinator(onDragChanged) }

    /// Main-actor because a recognizer's target/action always arrives there.
    @MainActor final class Coordinator: NSObject {
        private let haptic = UIImpactFeedbackGenerator(style: .heavy)
        /// Reassigned on every redraw, so the callback always reaches the
        /// current view's state rather than the one that built this coordinator.
        var onDragChanged: (IndexPath?) -> Void
        /// Watches `hasActiveDrag` for the length of one carry. Nil when no row
        /// is off the ground.
        private var poll: CADisplayLink?
        private weak var collection: UICollectionView?
        /// What we last told the view, so a poll tick only reports changes.
        private var carrying = false

        init(_ onDragChanged: @escaping (IndexPath?) -> Void) {
            self.onDragChanged = onDragChanged
        }

        @objc func press(_ g: UIGestureRecognizer) {
            guard g.state == .began else { return }
            haptic.impactOccurred()
            // Warmed for the next one: the first impact on a cold generator is
            // the one that arrives late.
            haptic.prepare()
            let collection = g.view as? UICollectionView
            beginCarry(collection, at: collection.flatMap {
                $0.indexPathForItem(at: g.location(in: $0))
            })
        }

        /// The press has armed: the row is up. Start watching for the drop.
        private func beginCarry(_ collection: UICollectionView?, at row: IndexPath?) {
            guard let collection, let row else { return }
            self.collection = collection
            carrying = true
            seen = false
            started = CACurrentMediaTime()
            onDragChanged(row)
            poll?.invalidate()
            let link = CADisplayLink(target: self, selector: #selector(tick))
            link.add(to: .main, forMode: .common)
            poll = link
        }

        /// Ends the carry once the drag session has been and gone.
        ///
        /// Two conditions, because `hasActiveDrag` is false at both ends of a
        /// drag — before the session starts and after it finishes — and only
        /// the second one is a drop. `seen` is what tells them apart.
        @objc private func tick() {
            guard let collection else { return endCarry() }
            let active = collection.hasActiveDrag
            if active { seen = true }
            // A lift that never became a drag — a long press the finger let go
            // of. `_UIDragLift` reports no cancel we can use, so this is the
            // only way back down.
            if !active && (seen || CACurrentMediaTime() - started > 1.5) {
                endCarry()
            }
        }

        private func endCarry() {
            poll?.invalidate()
            poll = nil
            seen = false
            collection = nil
            guard carrying else { return }
            carrying = false
            onDragChanged(nil)
        }

        /// Whether this carry has been an active drag at any point yet.
        private var seen = false
        /// When the carry began, for the no-drag-ever timeout above.
        private var started: CFTimeInterval = 0
    }

    func makeUIView(context: Context) -> UIView {
        let probe = UIView(frame: .zero)
        probe.isUserInteractionEnabled = false
        // After the view is in the hierarchy — in `makeUIView` it has no
        // superview yet, so there is nothing to walk up to.
        DispatchQueue.main.async { attach(from: probe, context.coordinator) }
        return probe
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.onDragChanged = onDragChanged
    }

    /// Walk out to the `List`'s scroll view and hook its drag-lift recognizers.
    private func attach(from probe: UIView, _ coordinator: Coordinator) {
        var view: UIView? = probe.superview
        while let v = view, !(v is UIScrollView) { view = v.superview }
        guard let scroll = view,
              objc_getAssociatedObject(scroll, Self.marker) == nil
        else { return }

        // Matched on the class name: the type is private to UIKit, so there is
        // nothing to cast to. A rename by Apple loses the buzz and breaks
        // nothing else. All of them, not the first — the list holds a touch
        // lift and a pointer one, and a finger arms only the touch one.
        let lifts = scroll.gestureRecognizers?.filter {
            String(describing: type(of: $0)).contains("DragLift")
        } ?? []
        guard !lifts.isEmpty else { return }
        objc_setAssociatedObject(scroll, Self.marker, true, .OBJC_ASSOCIATION_RETAIN)
        // An extra target only observes; each recognizer keeps its own.
        for lift in lifts {
            lift.addTarget(coordinator, action: #selector(Coordinator.press(_:)))
        }
    }
}
