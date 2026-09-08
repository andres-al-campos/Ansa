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
/// A UIKit recognizer added to the collection view underneath does see the
/// press, because `shouldRecognizeSimultaneouslyWith` is answered by our own
/// delegate rather than by SwiftUI's gesture graph.
///
/// The duration is a guess at `List`'s, which has no API. It errs late: a buzz
/// before the drag arms promises something that has not happened.
struct ListLiftFeedback: UIViewRepresentable {
    /// Marks the collection view we have already attached to, so a redraw does
    /// not add a second recognizer and buzz twice.
    private static let marker = UnsafeRawPointer(bitPattern: 0xA_11F7)!

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        private let haptic = UIImpactFeedbackGenerator(style: .heavy)

        @objc func press(_ g: UILongPressGestureRecognizer) {
            guard g.state == .began else { return }
            haptic.impactOccurred()
            // Warmed for the next one: the first impact on a cold generator is
            // the one that arrives late.
            haptic.prepare()
        }

        /// Never take the touch — `List` still has to run its own drag.
        func gestureRecognizer(
            _ g: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool { true }
    }

    func makeUIView(context: Context) -> UIView {
        let probe = UIView(frame: .zero)
        probe.isUserInteractionEnabled = false
        // After the view is in the hierarchy — in `makeUIView` it has no
        // superview yet, so there is nothing to walk up to.
        DispatchQueue.main.async { attach(from: probe, context.coordinator) }
        return probe
    }

    func updateUIView(_ uiView: UIView, context: Context) {}

    /// Walk out to the `List`'s scroll view and add the recognizer once.
    private func attach(from probe: UIView, _ coordinator: Coordinator) {
        var view: UIView? = probe.superview
        while let v = view, !(v is UIScrollView) { view = v.superview }
        guard let scroll = view,
              objc_getAssociatedObject(scroll, Self.marker) == nil
        else { return }
        objc_setAssociatedObject(scroll, Self.marker, true, .OBJC_ASSOCIATION_RETAIN)

        let press = UILongPressGestureRecognizer(
            target: coordinator, action: #selector(Coordinator.press(_:)))
        press.minimumPressDuration = 0.5
        // Both false, so the recognizer only watches: anything that swallowed
        // or delayed a touch here would break the row's tap and its swipes.
        press.cancelsTouchesInView = false
        press.delaysTouchesBegan = false
        press.delegate = coordinator
        scroll.addGestureRecognizer(press)
    }
}
