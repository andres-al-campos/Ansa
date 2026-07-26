/**
 * The two row controls, after the swap: the bullet folds, the chevron zooms.
 *
 * These used to be one control each way round — the twisty folded and the
 * bullet zoomed — so the point of pinning them is that clicking a bullet must
 * never navigate, and clicking the chevron must never fold.
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

test('clicking a bullet folds the row rather than zooming into it', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  const before = crumbs(container)
  expect(labels(container)).toContain('Dig out the P60')

  const bullet = row(container, /Gather the documents/).querySelector('button.bullet')!
  expect(bullet.getAttribute('aria-expanded')).toBe('true')
  click(bullet)

  // The children are gone, the parent stayed, and we did not navigate.
  expect(labels(container)).not.toContain('Dig out the P60')
  expect(labels(container)).toContain('Gather the documents')
  expect(bullet.getAttribute('aria-expanded')).toBe('false')
  expect(crumbs(container)).toEqual(before)
})

test('clicking the bullet again unfolds it', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  const bullet = () => row(container, /Gather the documents/).querySelector('button.bullet')!
  click(bullet())
  expect(labels(container)).not.toContain('Dig out the P60')
  click(bullet())
  expect(labels(container)).toContain('Dig out the P60')
})

test('a leaf bullet is inert — clicking it neither folds nor navigates', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  const before = labels(container)
  const crumbsBefore = crumbs(container)
  const bullet = row(container, /Dig out the P60/).querySelector('button.bullet')!

  // Nothing to fold, so it advertises no expanded state at all.
  expect(bullet.getAttribute('aria-expanded')).toBe(null)
  click(bullet)

  expect(labels(container)).toEqual(before)
  expect(crumbs(container)).toEqual(crumbsBefore)
})

test('the zoom control scopes into the row', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  const zoom = row(container, /Gather the documents/).querySelector('button.zoom')!
  click(zoom)

  // Now inside that row: its children are the whole list, and it is the crumb.
  expect(crumbs(container)).toContain('Gather the documents')
  expect(labels(container)).toContain('Dig out the P60')
  expect(labels(container)).not.toContain('Fill in the forms')
})

test('a leaf still offers zoom, so nothing is unreachable', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  const zoom = row(container, /Dig out the P60/).querySelector('button.zoom')!
  expect(zoom).toBeTruthy()
  click(zoom)
  expect(crumbs(container)).toContain('Dig out the P60')
})

test('the twisty is gone — the bullet is the only fold control', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)
  expect(container.querySelectorAll('.twisty')).toHaveLength(0)
})
