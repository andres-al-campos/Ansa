import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
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
  return [...container.querySelectorAll('.row')].map((r) => {
    const input = r.querySelector('input.label-input') as HTMLInputElement | null
    return input ? input.value : (r.querySelector('.label')?.textContent ?? '').trim()
  })
}

function row(container: HTMLElement, text: RegExp) {
  return [...container.querySelectorAll('.row')].find((r) =>
    text.test(r.textContent ?? ''),
  ) as HTMLElement
}

function editRow(container: HTMLElement, text: RegExp): HTMLInputElement {
  act(() => (row(container, text).querySelector('.label') as HTMLElement).click())
  return container.querySelector('input.label-input') as HTMLInputElement
}

/** Alt+Arrow on the row being edited. */
function move(input: HTMLInputElement, key: 'ArrowUp' | 'ArrowDown') {
  act(() => fireEvent.keyDown(input, { key, altKey: true }))
}

test('Alt+Down moves a row past its sibling', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /flat/i)

  const input = editRow(container, /Email the landlord/)
  move(input, 'ArrowDown')

  const rows = labels(container)
  expect(rows.indexOf('Email the landlord about the boiler')).toBe(
    rows.indexOf('Book a carpet clean') + 1,
  )
})

test('Alt+Down carries a row out of its parent instead of stopping', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  // "Dig out the P60" is the last child of "Gather the documents". The old
  // sibling-only reorder hit a wall here; it should now step down onto the
  // next visible row, which is the open parent "Fill in the forms".
  const before = labels(container)
  expect(before[before.length - 1]).not.toBe('Dig out the P60')

  const input = editRow(container, /Dig out the P60/)
  move(input, 'ArrowDown')

  const rows = labels(container)
  expect(rows.indexOf('Dig out the P60')).toBe(rows.indexOf('Fill in the forms') + 1)
})

test('Alt+Up lifts a first child out above its parent', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  // First child of "Gather the documents" — the visible row above is the
  // parent itself, so it lands directly above it as a sibling.
  const input = editRow(container, /Find last year's return PDF/)
  move(input, 'ArrowUp')

  const rows = labels(container)
  expect(rows.indexOf("Find last year's return PDF")).toBe(
    rows.indexOf('Gather the documents') - 1,
  )
  expect(rows[0]).toBe("Find last year's return PDF")
})

test('Alt+Up at the very top does nothing', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /flat/i)
  const before = labels(container)

  const input = editRow(container, /Email the landlord/)
  move(input, 'ArrowUp')

  expect(labels(container)).toEqual(before)
})

test('Alt+Down keeps unsaved text with the row it moves', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /flat/i)

  const input = editRow(container, /Email the landlord/)
  act(() => fireEvent.change(input, { target: { value: 'Chase the landlord' } }))
  move(input, 'ArrowDown')

  const rows = labels(container)
  expect(rows).toContain('Chase the landlord')
  expect(rows).not.toContain('Email the landlord about the boiler')
  expect(rows.indexOf('Chase the landlord')).toBe(rows.indexOf('Book a carpet clean') + 1)
})
