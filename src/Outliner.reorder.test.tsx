import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { seedTree } from '@shared/seed'
import Outliner from './Outliner'

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return { ...actual, sendOp: vi.fn(async () => ({ status: 'ok' }) as const), putTree: vi.fn(async () => true) }
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

/** Tick a row's checkbox, marking it done. */
function toggleDone(container: HTMLElement, text: RegExp) {
  act(() => (row(container, text).querySelector('button.check') as HTMLElement).click())
}

/** Flip one of the view checkboxes by its visible label. */
function setOption(container: HTMLElement, label: RegExp, on: boolean) {
  const box = [...container.querySelectorAll('label')]
    .find((l) => label.test(l.textContent ?? ''))!
    .querySelector('input[type=checkbox]') as HTMLInputElement
  act(() => fireEvent.click(box))
  expect(box.checked).toBe(on)
}

/** Cmd+Z on the window. Only fires when focus is outside a text field. */
function undo(container: HTMLElement) {
  act(() => fireEvent.keyDown(window, { key: 'z', metaKey: true }))
  return labels(container)
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

test('Alt+Down steps over a hidden completed row, landing past it', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /flat/i)

  // Complete the middle row, then hide completed. The list now draws two rows
  // with an invisible one between them — moving down must cross that gap in a
  // single press, since one keypress is one row *as drawn*.
  toggleDone(container, /Book a carpet clean/)
  setOption(container, /Hide completed tasks/, true)
  expect(labels(container)).toEqual([
    'Email the landlord about the boiler',
    'Replace the hallway bulb',
  ])

  const input = editRow(container, /Email the landlord/)
  move(input, 'ArrowDown')

  expect(labels(container)).toEqual([
    'Replace the hallway bulb',
    'Email the landlord about the boiler',
  ])
})

test('a hidden completed row survives a move across it', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /flat/i)

  toggleDone(container, /Book a carpet clean/)
  setOption(container, /Hide completed tasks/, true)
  const input = editRow(container, /Email the landlord/)
  move(input, 'ArrowDown')

  // Unhide: the completed row must still be there, not overwritten by whatever
  // landed on its index.
  setOption(container, /Hide completed tasks/, false)
  expect(labels(container)).toContain('Book a carpet clean')
  expect(labels(container)).toHaveLength(3)
})

test('undo rewinds a move and an indent one step at a time', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /flat/i)
  const before = labels(container)

  // Two structural edits in a row. "Book a carpet clean" has a sibling above
  // it, so Tab genuinely nests it; a first child would make Tab a no-op and
  // this would quietly test only half of what it claims.
  const input = editRow(container, /Book a carpet clean/)
  act(() => fireEvent.keyDown(input, { key: 'Tab' }))
  const indented = labels(container)
  move(container.querySelector('input.label-input') as HTMLInputElement, 'ArrowDown')
  const after = labels(container)
  expect(after).not.toEqual(indented)

  // Leave the field first: undo is a window shortcut and deliberately ignores
  // keys typed inside an input, where Cmd+Z means the browser's own text undo.
  act(() => fireEvent.blur(container.querySelector('input.label-input')!))

  // Each undo peels back exactly one edit. Blurring out of an unchanged field
  // must not cost a step of its own, or the first press would appear dead.
  undo(container)
  expect(labels(container)).toEqual(indented)
  undo(container)
  expect(labels(container)).toEqual(before)
})
