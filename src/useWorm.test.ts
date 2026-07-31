/**
 * The worm's shape.
 *
 * This arithmetic decides how finishing a branch feels, and it used to live
 * inside a click handler where the only way to exercise it was to click. The
 * two ends are what matter: a short branch should ripple at a leisurely pace,
 * and a long one should still be over quickly without collapsing into a flash.
 */

import { expect, test } from 'vitest'
import { WORM_CAP, WORM_RUN, WORM_STAGGER, wormStagger, wormWave } from './useWorm'

test('a short wave ripples at the full stagger', () => {
  // Nothing to compress: a handful of rows gets the leisurely spacing.
  expect(wormStagger(1)).toBe(WORM_STAGGER)
  expect(wormStagger(2)).toBe(WORM_STAGGER)
  expect(wormStagger(5)).toBe(WORM_STAGGER)
})

test('a long wave tightens so the sweep lands about at the cap', () => {
  // 30 rows at the full 100ms would be three seconds of wiggling for one
  // checkbox. The stagger tightens instead so the sweep — last row's delay plus
  // its own run — comes out near WORM_CAP. Near, not under: the stagger is
  // rounded to whole milliseconds, and 29 rounded gaps can overshoot by a few
  // ms. The cap is the target the arithmetic aims at, not a hard bound.
  const count = 30
  const stagger = wormStagger(count)
  expect(stagger).toBeLessThan(WORM_STAGGER)
  expect((count - 1) * stagger + WORM_RUN).toBeCloseTo(WORM_CAP, -2)
})

test('past a point the floor wins and the sweep runs long', () => {
  // The cap alone would drive the stagger to zero on a big branch, and every
  // row firing at once reads as a glitch rather than a wave. So the floor takes
  // over and the sweep is allowed to overrun the cap — a deliberate trade of
  // "over quickly" for "still legible as a wave".
  expect(wormStagger(1000)).toBe(20)
  expect(999 * wormStagger(1000) + WORM_RUN).toBeGreaterThan(WORM_CAP)
})

test('the wave delays each row by one stagger from the one before', () => {
  const wave = wormWave(['a', 'b', 'c'])
  expect(wave.get('a')).toBe(0)
  expect(wave.get('b')).toBe(WORM_STAGGER)
  expect(wave.get('c')).toBe(WORM_STAGGER * 2)
})

test('a row outside the wave has no delay', () => {
  // The render keys the `worm` class off this being undefined, so a miss has to
  // stay undefined rather than becoming 0 — which would wiggle every row.
  expect(wormWave(['a']).get('b')).toBeUndefined()
})
