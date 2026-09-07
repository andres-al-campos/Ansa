import AnsaCore
import SwiftUI
import UIKit

/// The completion ripple: rows wiggle one after another, top to bottom, when a
/// branch finishes. The wave's shape is `Ripple` in AnsaCore, shared with the
/// web; this holds the live wave and the timer that clears it.
///
/// One haptic as the wave starts, not one per row — a twelve-child branch
/// would buzz for a second straight and read as a malfunction.
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

/// The wiggle itself: a row sways right, then left, then settles, matching the
/// web's keyframes.
///
/// The delay is a sleep because SwiftUI has no way to offset a
/// `KeyframeAnimator`'s start.
///
/// Reduce Motion drops the movement and keeps the haptic — someone who asked
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
