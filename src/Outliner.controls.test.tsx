/**
 * The two row controls: the bullet zooms, the gutter triangle folds. That is
 * the arrangement Workflowy, Roam and Logseq all use.
 *
 * These have now been each way round — first twisty-folds/bullet-zooms, then
 * bullet-folds/chevron-zooms, now back — so the point of pinning them is that
 * clicking a bullet must never fold, and clicking the triangle must never
 * navigate. The bullet keeps *showing* the folded state either way; only which
 * object you click to change it moves.
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

test('clicking the triangle folds the row rather than zooming into it', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  const before = crumbs(container)
  expect(labels(container)).toContain('Dig out the P60')

  const fold = row(container, /Gather the documents/).querySelector('button.fold')!
  expect(fold.getAttribute('aria-expanded')).toBe('true')
  click(fold)

  // The children are gone, the parent stayed, and we did not navigate.
  expect(labels(container)).not.toContain('Dig out the P60')
  expect(labels(container)).toContain('Gather the documents')
  expect(
    row(container, /Gather the documents/).querySelector('button.fold')!.getAttribute(
      'aria-expanded',
    ),
  ).toBe('false')
  expect(crumbs(container)).toEqual(before)
})

test('clicking the triangle again unfolds it', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  const fold = () => row(container, /Gather the documents/).querySelector('button.fold')!
  click(fold())
  expect(labels(container)).not.toContain('Dig out the P60')
  click(fold())
  expect(labels(container)).toContain('Dig out the P60')
})

test('a leaf has no fold control to click', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  const before = labels(container)
  const crumbsBefore = crumbs(container)
  const fold = row(container, /Dig out the P60/).querySelector('button.fold')!

  // The button still holds the gutter open — dropping it would slide the row's
  // contents a column left — but it is empty and claims no expanded state.
  expect(fold).toBeTruthy()
  expect(fold.querySelector('svg')).toBeNull()
  expect(fold.getAttribute('aria-expanded')).toBe(null)
  click(fold)

  expect(labels(container)).toEqual(before)
  expect(crumbs(container)).toEqual(crumbsBefore)
})

test('clicking a bullet scopes into the row without folding it', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  const bullet = row(container, /Gather the documents/).querySelector('button.bullet')!
  click(bullet)

  // Now inside that row: its children are the whole list, and it is the crumb.
  expect(crumbs(container)).toContain('Gather the documents')
  expect(labels(container)).toContain('Dig out the P60')
  expect(labels(container)).not.toContain('Fill in the forms')
})

test('a leaf bullet zooms too, so nothing is unreachable', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  const bullet = row(container, /Dig out the P60/).querySelector('button.bullet')!
  expect(bullet).toBeTruthy()
  click(bullet)
  expect(crumbs(container)).toContain('Dig out the P60')
})

test('a collapsed parent bullet is marked so the halo rule can reach it', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  click(row(container, /Gather the documents/).querySelector('button.fold')!)
  const bullet = row(container, /Gather the documents/).querySelector('button.bullet')!

  // The bullet still *shows* the folded state even though the triangle is what
  // changed it. The halo selector is `.bullet.parent.collapsed`, and it once
  // lost a specificity fight with `.bullet.parent` and rendered no differently
  // at all. jsdom won't tell us the pixels, so pin the hook the rule needs.
  expect(bullet.classList.contains('parent')).toBe(true)
  expect(bullet.classList.contains('collapsed')).toBe(true)
})

test('the twisty is gone — the gutter triangle is the only fold control', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)
  expect(container.querySelectorAll('.twisty')).toHaveLength(0)
})
