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
struct ListLiftFeedback: UIViewRepresentable {
    /// Marks the collection view we have already hooked, so a redraw does not
    /// add a second target and buzz twice.
    private static let marker = UnsafeRawPointer(bitPattern: 0xA_11F7)!

    func makeCoordinator() -> Coordinator { Coordinator() }

    /// Main-actor because a recognizer's target/action always arrives there.
    @MainActor final class Coordinator: NSObject {
        private let haptic = UIImpactFeedbackGenerator(style: .heavy)

        @objc func press(_ g: UIGestureRecognizer) {
            guard g.state == .began else { return }
            haptic.impactOccurred()
            // Warmed for the next one: the first impact on a cold generator is
            // the one that arrives late.
            haptic.prepare()
        }

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
