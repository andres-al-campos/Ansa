/**
 * The ripple's shape.
 *
 * This arithmetic decides how finishing a branch feels, and it used to live
 * inside a click handler where the only way to exercise it was to click. The
 * two ends are what matter: a short branch should ripple at a leisurely pace,
 * and a long one should still be over quickly without collapsing into a flash.
 */

import { expect, test } from 'vitest'
import { RIPPLE_CAP, RIPPLE_RUN, RIPPLE_STAGGER, rippleStagger, rippleWave } from './useRipple'

test('a short wave ripples at the full stagger', () => {
  // Nothing to compress: a handful of rows gets the leisurely spacing.
  expect(rippleStagger(1)).toBe(RIPPLE_STAGGER)
  expect(rippleStagger(2)).toBe(RIPPLE_STAGGER)
  expect(rippleStagger(5)).toBe(RIPPLE_STAGGER)
})

test('a long wave tightens so the sweep lands about at the cap', () => {
  // 30 rows at the full 100ms would be three seconds of wiggling for one
  // checkbox. The stagger tightens instead so the sweep — last row's delay plus
  // its own run — comes out near RIPPLE_CAP. Near, not under: the stagger is
  // rounded to whole milliseconds, and 29 rounded gaps can overshoot by a few
  // ms. The cap is the target the arithmetic aims at, not a hard bound.
  const count = 30
  const stagger = rippleStagger(count)
  expect(stagger).toBeLessThan(RIPPLE_STAGGER)
  expect((count - 1) * stagger + RIPPLE_RUN).toBeCloseTo(RIPPLE_CAP, -2)
})

test('past a point the floor wins and the sweep runs long', () => {
  // The cap alone would drive the stagger to zero on a big branch, and every
  // row firing at once reads as a glitch rather than a wave. So the floor takes
  // over and the sweep is allowed to overrun the cap — a deliberate trade of
  // "over quickly" for "still legible as a wave".
  expect(rippleStagger(1000)).toBe(20)
  expect(999 * rippleStagger(1000) + RIPPLE_RUN).toBeGreaterThan(RIPPLE_CAP)
})

test('the wave delays each row by one stagger from the one before', () => {
  const wave = rippleWave(['a', 'b', 'c'])
  expect(wave.get('a')).toBe(0)
  expect(wave.get('b')).toBe(RIPPLE_STAGGER)
  expect(wave.get('c')).toBe(RIPPLE_STAGGER * 2)
})

test('a row outside the wave has no delay', () => {
  // The render keys the `ripple` class off this being undefined, so a miss has to
  // stay undefined rather than becoming 0 — which would wiggle every row.
  expect(rippleWave(['a']).get('b')).toBeUndefined()
})
