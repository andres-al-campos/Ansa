/**
 * Folding and unfolding a parent moves every row below it. Rather than let the
 * list jump, the rows below are slid to their new place with FLIP: measure,
 * relayout, invert with a transform, then release it.
 *
 * jsdom has no layout — every `getBoundingClientRect` is zero — so the slide
 * itself can't be exercised here, and nor can the stagger's geometry. What
 * these pin is everything around it: that the animation only ever fires for a
 * fold, that it leaves no inline state stuck on a row afterwards, and that
 * unmounting mid-slide cleans up. Those are the failure modes that outlive a
 * missing animation — a row left with `transition: transform` quietly animates
 * the next drag, which is much worse than a fold that doesn't glide.
 *
 * The visual smoothness is verified in the browser, not here.
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { clerkMock } from './testClerk'
import { silenceSocket } from './testSocket'
import { act, cleanup, render } from '@testing-library/react'
import { seedTree } from '@shared/seed'
import Outliner from './Outliner'

vi.mock('@clerk/clerk-react', () => clerkMock())
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return { ...actual, sendOp: vi.fn(async () => ({ status: 'ok' }) as const), putTree: vi.fn(async () => true) }
})

beforeEach(() => {
  silenceSocket()
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

const liveRows = (c: HTMLElement) => c.querySelectorAll('.row[data-id]')

/**
 * Rows carrying inline animation state — mid-slide, or clipped beneath the mask
 * while opening. `clipPath` is the one that really bites: an arriving row starts
 * at `inset(0 0 100% 0)`, which clips it away completely so the mask can show
 * its clone instead, so a row that keeps it is invisible for good rather than
 * merely un-animated.
 */
const animating = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLElement>('.row[data-id]')].filter(
    (r) => r.style.transform || r.style.transition || r.style.animation || r.style.clipPath,
  )

/** Fold a row. The bullet is the fold control; the arrow at the edge zooms. */
const fold = (c: HTMLElement, text: RegExp) =>
  row(c, text).querySelector('.bullet') as HTMLElement

/** Long enough for the slide, the staggered fade, and the cleanup after both. */
const settle = () => act(() => void vi.advanceTimersByTime(2000))

test('a fold leaves no inline animation state behind once it settles', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  act(() => fold(container, /Gather the documents/).click())
  settle()

  // The slide sets `transition: transform` inline to run. Leaving it there
  // would hand the next move of this row — a drag, which has to track the
  // pointer exactly — a 160ms easing curve it never asked for.
  expect(animating(container)).toHaveLength(0)
})

test('unfolding also settles clean', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  act(() => fold(container, /Gather the documents/).click())
  settle()
  const folded = liveRows(container).length

  act(() => fold(container, /Gather the documents/).click())
  settle()

  expect(liveRows(container).length).toBeGreaterThan(folded)
  // Arriving children start fully clipped, hidden beneath the mask until it
  // finishes. If that state is not cleared they stay clipped permanently —
  // occupying their space in the list, drawing nothing.
  expect(animating(container)).toHaveLength(0)
})

test('collapsing cleans up the mask it parks over the list', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)
  settle()

  act(() => fold(container, /Gather the documents/).click())
  settle()

  // The mask is appended to the document rather than rendered by React, so
  // nothing else will ever take it away. One left behind is a dead band of
  // cloned rows floating over the list, outliving the rows it copied.
  expect(container.querySelectorAll('.fold-mask')).toHaveLength(0)
})

test('the mask is not a row, so nothing that walks the list can see it', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)
  settle()

  const before = liveRows(container).length
  act(() => fold(container, /Gather the documents/).click())

  // Mid-collapse the mask and its cloned rows are on screen. They must not
  // answer to `.row` or carry a `data-id` — the drag hit-test walks
  // `.row[data-id]` in document order, and a clone in that walk is a drop
  // target on a row that no longer exists.
  expect(liveRows(container).length).toBeLessThan(before)
  const mask = container.querySelector('.fold-mask')
  expect(mask?.getAttribute('aria-hidden')).toBe('true')
  for (const clone of container.querySelectorAll('.fold-mask-item')) {
    expect(clone.classList.contains('row')).toBe(false)
    expect(clone.getAttribute('data-id')).toBe(null)
  }
})

test('an unfold interrupted mid-reveal still leaves its children visible', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  act(() => fold(container, /Gather the documents/).click())
  settle()

  // Open it, then fold something else before the reveal finishes. The first
  // effect's cleanup runs mid-flight, and it owns the only copy of these rows'
  // clip state — drop it there and the children never come back.
  act(() => fold(container, /Gather the documents/).click())
  act(() => fold(container, /Send it off/).click())
  settle()

  const clipped = [...container.querySelectorAll<HTMLElement>('.row[data-id]')].filter(
    (r) => r.style.clipPath,
  )
  expect(clipped).toHaveLength(0)
})

test('a second fold on top of an unfinished one does not strand the first', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  // Fold, then immediately fold something else without letting the first
  // finish. The effect's cleanup runs for the first fold as the second commits.
  act(() => fold(container, /Gather the documents/).click())
  act(() => fold(container, /Fill in the forms/).click())
  settle()

  expect(animating(container)).toHaveLength(0)
})

test('unmounting mid-slide does not throw', () => {
  const { container, unmount } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  // The rAF that starts the slide and the timer that cleans it up are both
  // still pending here. Both are cancelled on unmount; if they weren't, they'd
  // reach for elements that no longer exist.
  act(() => fold(container, /Gather the documents/).click())
  expect(() => unmount()).not.toThrow()
  expect(() => vi.advanceTimersByTime(2000)).not.toThrow()
})

test('navigating to another project does not animate the arrival', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)
  settle()

  // A whole new set of rows, none of which is a fold. Fading them in one by
  // one would replay the entire list on every navigation.
  const crumb = [...container.querySelectorAll('.crumbs button')].find((b) =>
    /Projects/.test(b.textContent ?? ''),
  ) as HTMLElement
  act(() => crumb.click())
  scopeInto(container, /Sort out the flat/i)

  expect(animating(container)).toHaveLength(0)
})
