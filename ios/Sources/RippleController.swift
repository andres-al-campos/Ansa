import AnsaCore
import SwiftUI
import UIKit

/// The completion ripple: rows wiggle one after another, top to bottom, when a
/// branch finishes.
///
/// The arithmetic deciding the wave's shape is `Ripple` in AnsaCore, ported from
/// the web so both platforms wiggle the same way. This holds only the live wave
/// and the timer that clears it.
///
/// The phone adds one thing the web has no way to: a single haptic tap as the
/// wave starts. One, not one per row — a twelve-child branch would otherwise
/// buzz for a second straight, which reads as a malfunction rather than a
/// reward. `.soft` rather than `.light` because the wiggle is a gentle sway and
/// a crisp tick against it is a mismatch of register.
@MainActor
@Observable
final class RippleController {
    /// Row id → its delay into the current wave. Rows outside the wave are
    /// absent rather than zero: the view keys the animation off nil, so a miss
    /// that came back as 0 would wiggle every row on screen.
    private(set) var wave: [NodeId: Double] = [:]

    @ObservationIgnored private var clear: Task<Void, Never>?
    /// Prepared before use so the Taptic Engine is already spun up when the tap
    /// comes; without it the first haptic of a session lands late enough to feel
    /// disconnected from the tap that caused it.
    @ObservationIgnored private let haptic = UIImpactFeedbackGenerator(style: .soft)

    /// The delay for a row, or nil if it isn't in the current wave.
    func delay(for id: NodeId) -> Double? { wave[id] }

    /// Start a wave over these rows, in the order they should wiggle.
    func start(_ ids: [NodeId]) {
        guard !ids.isEmpty else { return }
        wave = Ripple.wave(ids)
        haptic.impactOccurred()
        haptic.prepare()

        clear?.cancel()
        let last = wave.values.max() ?? 0
        clear = Task { [weak self] in
            // A little slack past the last row's run, so the wave outlives the
            // animation rather than cutting it off mid-wiggle.
            try? await Task.sleep(for: .seconds(last + Ripple.run + 0.1))
            guard !Task.isCancelled else { return }
            self?.wave = [:]
        }
    }

    func prepare() { haptic.prepare() }
}

/// The wiggle itself: a row sways right, then left, then settles.
///
/// `±2pt` over 0.4s, matching the web's keyframes. A sway rather than a shake —
/// this marks something finished, and a shake reads as a rejection.
///
/// The delay is a sleep rather than an animation delay because SwiftUI has no
/// way to offset a `KeyframeAnimator`'s start; holding the row still for its
/// turn and then triggering is the same thing from the outside.
///
/// Reduce Motion drops the movement and keeps the haptic. Someone who has asked
/// for less motion has not asked for less feedback.
struct RippleWiggle: ViewModifier {
    /// This row's offset into the wave, or nil when it isn't in one.
    let delay: Double?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var run = 0

    func body(content: Content) -> some View {
        content
            .keyframeAnimator(initialValue: 0.0, trigger: run) { view, x in
                view.offset(x: x)
            } keyframes: { _ in
                KeyframeTrack {
                    // 33% right, 66% left, back to rest — the web's curve, in
                    // seconds rather than percentages.
                    CubicKeyframe(2, duration: Ripple.run * 0.33)
                    CubicKeyframe(-2, duration: Ripple.run * 0.33)
                    CubicKeyframe(0, duration: Ripple.run * 0.34)
                }
            }
            .task(id: delay) {
                guard let delay, !reduceMotion else { return }
                try? await Task.sleep(for: .seconds(delay))
                guard !Task.isCancelled else { return }
                run += 1
            }
    }
}
