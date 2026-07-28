/**
 * Folding a parent drops its whole subtree from the row list in one frame. To
 * animate that, the departing rows are held on screen as inert stand-ins while
 * they shrink, then dropped for real.
 *
 * The risk in that arrangement is a stand-in that never leaves: it is a
 * `.row` holding a row's worth of vertical space, with no content and no way
 * for the user to get rid of it. So the tests here are mostly about the
 * *disappearance* rather than the appearance.
 *
 * jsdom runs no CSS animations, so `animationend` never fires here. That makes
 * this the fallback path — the backstop timer — which is the one that has to
 * hold when the animation doesn't run: a background tab, reduced-motion, an
 * older browser.
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { seedTree } from '@shared/seed'
import Outliner from './Outliner'

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return { ...actual, sendOp: vi.fn(async () => true), putTree: vi.fn(async () => true) }
})

class SilentEventSource {
  onmessage: ((e: { data: string }) => void) | null = null
  constructor(public url: string) {}
  close() {}
}

beforeEach(() => {
  vi.stubGlobal('EventSource', SilentEventSource as unknown as typeof EventSource)
  vi.useFakeTimers()
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function scopeInto(container: HTMLElement, name: RegExp) {
  const card = [...container.querySelectorAll('button.proj')].find((b) =>
    name.test(b.textContent ?? ''),
  ) as HTMLElement
  act(() => card.click())
}

function row(container: HTMLElement, text: RegExp) {
  return [...container.querySelectorAll('.row')].find((r) =>
    text.test(r.textContent ?? ''),
  ) as HTMLElement
}

const standins = (c: HTMLElement) => c.querySelectorAll('.row.closing')
const liveRows = (c: HTMLElement) => c.querySelectorAll('.row[data-id]')

test('folding leaves stand-ins behind, then clears them', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  const before = liveRows(container).length
  act(() => (row(container, /Gather the documents/).querySelector('.fold') as HTMLElement).click())

  // The children left the list, and the same number of stand-ins took their
  // place so the list doesn't jump before it animates.
  const after = liveRows(container).length
  expect(after).toBeLessThan(before)
  expect(standins(container)).toHaveLength(before - after)

  // And they go. This is the whole point: a stand-in is an empty box holding
  // a row's worth of space, so one that outlives the animation is dead space
  // in the list with nothing the user can do about it.
  act(() => void vi.advanceTimersByTime(2000))
  expect(standins(container)).toHaveLength(0)
  expect(liveRows(container)).toHaveLength(after)
})

test('a stand-in is inert — no id, no controls, hidden from readers', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)
  act(() => (row(container, /Gather the documents/).querySelector('.fold') as HTMLElement).click())

  const ghost = standins(container)[0]
  expect(ghost).toBeTruthy()

  // No data-id: `hitTest` walks `.row[data-id]` to find drop targets, and a
  // stand-in is not a droppable row — it is a row that has already left.
  expect(ghost.getAttribute('data-id')).toBe(null)
  // No focusable controls, or folding would leave tab stops behind.
  expect(ghost.querySelectorAll('button')).toHaveLength(0)
  expect(ghost.getAttribute('aria-hidden')).toBe('true')
})

test('unfolding does not leave stand-ins', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)
  const fold = () => row(container, /Gather the documents/).querySelector('.fold') as HTMLElement

  act(() => fold().click())
  act(() => void vi.advanceTimersByTime(2000))
  const folded = liveRows(container).length

  // Opening adds rows rather than removing them, so nothing is on its way out.
  act(() => fold().click())
  expect(standins(container)).toHaveLength(0)
  expect(liveRows(container).length).toBeGreaterThan(folded)
})

test('hiding completed rows is not a fold, so nothing shrinks', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  // Complete a leaf so the filter has something to take away.
  act(() => (row(container, /Dig out the P60/).querySelector('.check') as HTMLElement).click())
  act(() => void vi.advanceTimersByTime(2000))
  const before = liveRows(container).length

  // Now hide it. Rows leave the list while the list stays on screen — the same
  // shape as a fold, and the case the fold check has to tell apart. Animating
  // it would replay part of the list every time a filter is toggled.
  const toggle = [...container.querySelectorAll('.filters label')].find((l) =>
    /Hide completed/i.test(l.textContent ?? ''),
  )!
  const box = toggle.querySelector('input[type="checkbox"]') as HTMLElement
  act(() => box.click())

  expect(liveRows(container).length).toBeLessThan(before)
  expect(standins(container)).toHaveLength(0)
})
