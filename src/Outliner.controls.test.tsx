/**
 * The two row controls: the bullet folds, the arrow at the right edge zooms.
 * This matches the phone, where tapping the bullet is the whole interaction.
 *
 * These have now been each way round three times — twisty-folds/bullet-zooms,
 * then bullet-folds/chevron-zooms, then back, and now here — so the point of
 * pinning them is that clicking a bullet must never navigate, and clicking the
 * arrow must never fold. The bullet keeps *showing* the folded state through
 * every one of those arrangements; only which object you click to change it
 * moves.
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { silenceSocket } from './testSocket'
import { act, cleanup, render } from '@testing-library/react'
import { seedTree } from '@shared/seed'
import Outliner from './Outliner'

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return { ...actual, sendOp: vi.fn(async () => ({ status: 'ok' }) as const), putTree: vi.fn(async () => true) }
})

beforeEach(() => {
  silenceSocket()
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function scopeInto(container: HTMLElement, name: RegExp) {
  const card = [...container.querySelectorAll('button.proj')].find((b) =>
    name.test(b.textContent ?? ''),
  ) as HTMLElement
  act(() => card.click())
}

function labels(container: HTMLElement) {
  return [...container.querySelectorAll('.row .label')].map((l) => (l.textContent ?? '').trim())
}

function row(container: HTMLElement, text: RegExp) {
  return [...container.querySelectorAll('.row')].find((r) =>
    text.test(r.textContent ?? ''),
  ) as HTMLElement
}

/** The current breadcrumb trail, which is how zoom shows up. */
function crumbs(container: HTMLElement) {
  return [...container.querySelectorAll('.crumbs button')].map((b) => (b.textContent ?? '').trim())
}

function click(el: Element) {
  act(() => (el as HTMLElement).click())
}

/** The zoom arrow at the row's right edge. */
function zoom(container: HTMLElement, text: RegExp) {
  return row(container, text).querySelector('button.zoom')!
}

/** The bullet, which is now the fold control. */
function bullet(container: HTMLElement, text: RegExp) {
  return row(container, text).querySelector('button.bullet')!
}

test('clicking a bullet folds the row rather than zooming into it', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  const before = crumbs(container)
  expect(labels(container)).toContain('Dig out the P60')

  expect(bullet(container, /Gather the documents/).getAttribute('aria-expanded')).toBe('true')
  click(bullet(container, /Gather the documents/))

  // The children are gone, the parent stayed, and we did not navigate.
  expect(labels(container)).not.toContain('Dig out the P60')
  expect(labels(container)).toContain('Gather the documents')
  expect(bullet(container, /Gather the documents/).getAttribute('aria-expanded')).toBe('false')
  expect(crumbs(container)).toEqual(before)
})

test('clicking the bullet again unfolds it', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  click(bullet(container, /Gather the documents/))
  expect(labels(container)).not.toContain('Dig out the P60')
  click(bullet(container, /Gather the documents/))
  expect(labels(container)).toContain('Dig out the P60')
})

test('a leaf bullet folds nothing and stays out of the tab order', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  const before = labels(container)
  const crumbsBefore = crumbs(container)
  const leaf = bullet(container, /Dig out the P60/)

  // It is still rendered — it draws the row's dot and it is the drag handle —
  // but it claims no expanded state and announces nothing, because a click on
  // it does nothing. A `folds` marker is what CSS reads for the cursor, and it
  // must not be there.
  expect(leaf).toBeTruthy()
  expect(leaf.getAttribute('aria-expanded')).toBe(null)
  expect(leaf.classList.contains('folds')).toBe(false)
  expect(leaf.getAttribute('tabindex')).toBe('-1')
  click(leaf)

  expect(labels(container)).toEqual(before)
  expect(crumbs(container)).toEqual(crumbsBefore)
})

test('the marker for "this bullet folds" tracks children, not the ring', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  // A bullet draws a ring when it is a parent *or* sits at the top level, so a
  // top-level childless row is `.parent` while folding nothing. The cursor rule
  // reads `.folds`, and if that were keyed on the ring instead, such a row would
  // show a pointer for a click that does nothing.
  const parent = bullet(container, /Gather the documents/)
  expect(parent.classList.contains('folds')).toBe(true)

  for (const b of container.querySelectorAll('button.bullet')) {
    const foldable = b.getAttribute('aria-expanded') !== null
    expect(b.classList.contains('folds')).toBe(foldable)
  }
})

test('clicking the arrow scopes into the row without folding it', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  click(zoom(container, /Gather the documents/))

  // Now inside that row: its children are the whole list, and it is the crumb.
  expect(crumbs(container)).toContain('Gather the documents')
  expect(labels(container)).toContain('Dig out the P60')
  expect(labels(container)).not.toContain('Fill in the forms')
})

test('a leaf has an arrow too, so nothing is unreachable', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  const arrow = zoom(container, /Dig out the P60/)
  expect(arrow).toBeTruthy()
  click(arrow)
  expect(crumbs(container)).toContain('Dig out the P60')
})

test('every row carries an arrow, so zoom never depends on the row having children', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  const rows = [...container.querySelectorAll('.row')]
  expect(rows.length).toBeGreaterThan(1)
  for (const r of rows) {
    expect(r.querySelector('button.zoom'), (r.textContent ?? '') + ' has no zoom').toBeTruthy()
  }
})

test('a collapsed parent bullet is marked so the halo rule can reach it', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  click(bullet(container, /Gather the documents/))
  const b = bullet(container, /Gather the documents/)

  // The bullet shows the folded state and is also what changed it — one object
  // now, where the triangle used to be the other half. The halo selector is
  // `.bullet.parent.collapsed`, and it once lost a specificity fight with
  // `.bullet.parent` and rendered no differently at all. jsdom won't tell us the
  // pixels, so pin the hook the rule needs.
  expect(b.classList.contains('parent')).toBe(true)
  expect(b.classList.contains('collapsed')).toBe(true)
})

test('neither the twisty nor the gutter triangle survives', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)
  expect(container.querySelectorAll('.twisty')).toHaveLength(0)
  expect(container.querySelectorAll('button.fold')).toHaveLength(0)
})
