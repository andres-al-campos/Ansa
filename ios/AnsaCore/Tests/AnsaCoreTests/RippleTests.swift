/// Ported from `src/useRipple.test.ts`, case for case.
///
/// The ripple's shape. This arithmetic decides how finishing a branch feels,
/// and the two ends are what matter: a short branch should ripple at a
/// leisurely pace, and a long one should still be over quickly without
/// collapsing into a flash.
///
/// Ported rather than reinvented so the wiggle reads the same on both
/// platforms. When the TypeScript gains a case, port it here.

import Testing
@testable import AnsaCore

@Suite("the completion ripple's shape")
struct RippleTests {
    @Test("a short wave ripples at the full stagger")
    func shortWave() {
        // Nothing to compress: a handful of rows gets the leisurely spacing.
        #expect(Ripple.stagger(for: 1) == Ripple.stagger)
        #expect(Ripple.stagger(for: 2) == Ripple.stagger)
        #expect(Ripple.stagger(for: 5) == Ripple.stagger)
    }

    @Test("a long wave tightens so the sweep lands about at the cap")
    func longWave() {
        // 30 rows at the full 100ms would be three seconds of wiggling for one
        // checkbox. The stagger tightens instead so the sweep — last row's delay
        // plus its own run — comes out near the cap. Near, not under: the
        // stagger is rounded to whole milliseconds, and 29 rounded gaps can
        // overshoot by a few ms.
        let count = 30
        let gap = Ripple.stagger(for: count)
        #expect(gap < Ripple.stagger)
        let sweep = Double(count - 1) * gap + Ripple.run
        #expect(abs(sweep - Ripple.cap) < 0.05)
    }

    @Test("past a point the floor wins and the sweep runs long")
    func floorWins() {
        // The cap alone would drive the stagger to zero on a big branch, and
        // every row firing at once reads as a glitch rather than a wave. So the
        // floor takes over and the sweep is allowed to overrun the cap.
        #expect(Ripple.stagger(for: 1000) == 0.02)
        #expect(999 * Ripple.stagger(for: 1000) + Ripple.run > Ripple.cap)
    }

    @Test("the wave delays each row by one stagger from the one before")
    func waveDelays() {
        let wave = Ripple.wave(["a", "b", "c"])
        #expect(wave["a"] == 0)
        #expect(wave["b"] == Ripple.stagger)
        #expect(wave["c"] == Ripple.stagger * 2)
    }

    @Test("a row outside the wave has no delay")
    func outsideWave() {
        // The view keys the wiggle off this being nil, so a miss has to stay nil
        // rather than becoming 0 — which would wiggle every row.
        #expect(Ripple.wave(["a"])["b"] == nil)
    }
}
