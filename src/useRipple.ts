/**
 * The completion ripple: a little wave that travels down a branch when it's
 * finished.
 *
 * Split from the component because it is self-contained — a map of row id to
 * delay, a timer that clears it, and the arithmetic deciding the wave's shape.
 * That arithmetic is the part worth having on its own: it is pure, it decides
 * how the animation feels, and inside a click handler there was no way to check
 * it without clicking.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { NodeId } from '@shared/tree'

// Each row wiggles for RIPPLE_RUN, offset from the previous by RIPPLE_STAGGER.
// On long waves the stagger tightens so the whole sweep clears within
// RIPPLE_CAP instead of crawling — same little wave, just faster.
export const RIPPLE_RUN = 400
export const RIPPLE_STAGGER = 100
export const RIPPLE_CAP = 1000

/**
 * The gap between one row's wiggle and the next.
 *
 * A constant stagger reads well on a short branch and crawls on a long one: 30
 * rows at 100ms each is three seconds of wiggling for one checkbox. Tightening
 * the gap keeps the wave the same shape and just moves it faster, so the whole
 * sweep lands inside RIPPLE_CAP. The 20ms floor stops a very long branch
 * collapsing into a single simultaneous flash, which reads as a glitch rather
 * than a wave.
 */
export function rippleStagger(count: number): number {
  if (count <= 1) return RIPPLE_STAGGER
  return Math.round(Math.min(RIPPLE_STAGGER, Math.max(20, (RIPPLE_CAP - RIPPLE_RUN) / (count - 1))))
}

/** Row id → its delay into the wave, for the rows that should wiggle. */
export type RippleWave = Map<NodeId, number>

/** Build the wave: each row in visual order, staggered from the one before. */
export function rippleWave(ids: NodeId[]): RippleWave {
  const stagger = rippleStagger(ids.length)
  const wave: RippleWave = new Map()
  ids.forEach((id, i) => wave.set(id, i * stagger))
  return wave
}

export interface Ripple {
  /** The delay for a row, or undefined if it isn't in the current wave. */
  delayFor: (id: NodeId) => number | undefined
  /** Start a wave over these rows, in the order they should ripple. */
  start: (ids: NodeId[]) => void
}

export function useRipple(): Ripple {
  const [wave, setWave] = useState<RippleWave>(new Map())
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  // Stable for the hook's lifetime: it only touches setWave and the timer ref,
  // both of which React guarantees are themselves stable. Worth pinning because
  // a handler that changes identity every render is a silent trap for the first
  // effect or memo that lists it as a dependency.
  const start = useCallback((ids: NodeId[]) => {
    const next = rippleWave(ids)
    setWave(next)
    window.clearTimeout(timer.current)
    // Clear once the last row has finished its run, plus a little slack so the
    // class outlives the animation rather than cutting it off.
    const last = Math.max(0, ...next.values())
    timer.current = window.setTimeout(() => setWave(new Map()), last + RIPPLE_RUN + 100)
  }, [])

  // This one *should* change when the wave does — that identity change is what
  // re-renders the rows as the wave starts and clears. Memoised on the wave
  // rather than pinned, so it stays correct rather than merely stable.
  const delayFor = useCallback((id: NodeId) => wave.get(id), [wave])

  return { delayFor, start }
}
