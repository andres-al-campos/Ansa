/// The completion ripple: a little wave that travels down a branch when it's
/// finished.
///
/// Ported from `src/useRipple.ts`. Only the arithmetic lives here — the timing
/// and the animation itself belong to the view. That split is the same one the
/// web makes, and for the same reason: this part is pure, it decides how the
/// animation feels, and inside a tap handler there is no way to check it
/// without tapping.
public enum Ripple {
    // Each row wiggles for `run`, offset from the previous by `stagger`. On long
    // waves the stagger tightens so the whole sweep clears within `cap` instead
    // of crawling — same little wave, just faster.
    public static let run: Double = 0.4
    public static let stagger: Double = 0.1
    public static let cap: Double = 1.0

    /// The gap between one row's wiggle and the next.
    ///
    /// A constant stagger reads well on a short branch and crawls on a long one:
    /// 30 rows at 100ms each is three seconds of wiggling for one checkbox.
    /// Tightening the gap keeps the wave the same shape and just moves it
    /// faster, so the whole sweep lands inside `cap`. The 20ms floor stops a
    /// very long branch collapsing into a single simultaneous flash, which reads
    /// as a glitch rather than a wave.
    public static func stagger(for count: Int) -> Double {
        guard count > 1 else { return stagger }
        let fitted = (cap - run) / Double(count - 1)
        // Rounded to whole milliseconds, matching the web's Math.round, so the
        // two platforms agree on the wave rather than drifting by a fraction.
        return (min(stagger, max(0.02, fitted)) * 1000).rounded() / 1000
    }

    /// Row id → its delay into the wave, for the rows that should wiggle.
    public static func wave(_ ids: [NodeId]) -> [NodeId: Double] {
        let gap = stagger(for: ids.count)
        var wave: [NodeId: Double] = [:]
        for (i, id) in ids.enumerated() {
            wave[id] = Double(i) * gap
        }
        return wave
    }
}
