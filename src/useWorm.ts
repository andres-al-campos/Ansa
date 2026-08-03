/**
 * The completion worm: a little wave that travels down a branch when it's
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

// Each row wiggles for WORM_RUN, offset from the previous by WORM_STAGGER. On
// long waves the stagger tightens so the whole sweep clears within WORM_CAP
// instead of crawling — same little wave, just faster.
export const WORM_RUN = 400
export const WORM_STAGGER = 100
export const WORM_CAP = 1000

/**
 * The gap between one row's wiggle and the next.
 *
 * A constant stagger reads well on a short branch and crawls on a long one: 30
 * rows at 100ms each is three seconds of wiggling for one checkbox. Tightening
 * the gap keeps the wave the same shape and just moves it faster, so the whole
 * sweep lands inside WORM_CAP. The 20ms floor stops a very long branch
 * collapsing into a single simultaneous flash, which reads as a glitch rather
 * than a wave.
 */
export function wormStagger(count: number): number {
  if (count <= 1) return WORM_STAGGER
  return Math.round(Math.min(WORM_STAGGER, Math.max(20, (WORM_CAP - WORM_RUN) / (count - 1))))
}

/** Row id → its delay into the wave, for the rows that should wiggle. */
export type WormWave = Map<NodeId, number>

/** Build the wave: each row in visual order, staggered from the one before. */
export function wormWave(ids: NodeId[]): WormWave {
  const stagger = wormStagger(ids.length)
  const wave: WormWave = new Map()
  ids.forEach((id, i) => wave.set(id, i * stagger))
  return wave
}

export interface Worm {
  /** The delay for a row, or undefined if it isn't in the current wave. */
  delayFor: (id: NodeId) => number | undefined
  /** Start a wave over these rows, in the order they should ripple. */
  start: (ids: NodeId[]) => void
}

export function useWorm(): Worm {
  const [wave, setWave] = useState<WormWave>(new Map())
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  // Stable for the hook's lifetime: it only touches setWave and the timer ref,
  // both of which React guarantees are themselves stable. Worth pinning because
  // a handler that changes identity every render is a silent trap for the first
  // effect or memo that lists it as a dependency.
  const start = useCallback((ids: NodeId[]) => {
    const next = wormWave(ids)
    setWave(next)
    window.clearTimeout(timer.current)
    // Clear once the last row has finished its run, plus a little slack so the
    // class outlives the animation rather than cutting it off.
    const last = Math.max(0, ...next.values())
    timer.current = window.setTimeout(() => setWave(new Map()), last + WORM_RUN + 100)
  }, [])

  // This one *should* change when the wave does — that identity change is what
  // re-renders the rows as the wave starts and clears. Memoised on the wave
  // rather than pinned, so it stays correct rather than merely stable.
  const delayFor = useCallback((id: NodeId) => wave.get(id), [wave])

  return { delayFor, start }
}
