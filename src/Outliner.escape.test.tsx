import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { silenceSocket } from './testSocket'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { seedTree } from '@shared/seed'
import Outliner from './Outliner'

// Editing is local-first, so none of this needs the server.
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

/** Visible row labels, reading the input for whichever row is being edited. */
function labels(container: HTMLElement) {
  return [...container.querySelectorAll('.row')].map((r) => {
    const input = r.querySelector('input.label-input') as HTMLInputElement | null
    return input ? input.value : (r.querySelector('.label')?.textContent ?? '').trim()
  })
}

function editRow(container: HTMLElement, text: RegExp): HTMLInputElement {
  const row = [...container.querySelectorAll('.row')].find((r) => text.test(r.textContent ?? ''))!
  act(() => (row.querySelector('.label') as HTMLElement).click())
  return container.querySelector('input.label-input') as HTMLInputElement
}

/**
 * Escape, then the blur that follows as the input unmounts. Leaving the blur
 * out would test a keypress no real user can make — the field always loses
 * focus on the way out, and that blur is where the bug lives.
 */
function escapeAndBlur(input: HTMLInputElement) {
  act(() => {
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.blur(input)
  })
}

test('Escape on a new empty row removes it and leaves nothing behind', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /flat/i)
  const before = labels(container)

  // Make a fresh row with Enter, then back out of it without typing.
  const first = editRow(container, /Email the landlord/)
  act(() => {
    fireEvent.change(first, { target: { value: 'Email the landlord about the boiler' } })
    fireEvent.keyDown(first, { key: 'Enter' })
  })
  const blank = container.querySelector('input.label-input') as HTMLInputElement
  escapeAndBlur(blank)

  expect(labels(container)).toEqual(before)
})

test('Escape on a new row discards text typed into it', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /flat/i)
  const before = labels(container)

  const first = editRow(container, /Email the landlord/)
  act(() => {
    fireEvent.change(first, { target: { value: 'Email the landlord about the boiler' } })
    fireEvent.keyDown(first, { key: 'Enter' })
  })
  // Type into the new row, then change your mind. The row was never committed,
  // so Escape should back out of creating it rather than keep the draft.
  const blank = container.querySelector('input.label-input') as HTMLInputElement
  act(() => fireEvent.change(blank, { target: { value: 'half a thought' } }))
  escapeAndBlur(blank)

  expect(labels(container)).toEqual(before)
  expect(container.textContent).not.toContain('half a thought')
})

test('Escape on an existing row keeps the old text, not the edit', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /flat/i)

  // Rename an established row, then back out. The original name must stand.
  const input = editRow(container, /Book a carpet clean/)
  act(() => fireEvent.change(input, { target: { value: 'something else entirely' } }))
  escapeAndBlur(input)

  expect(labels(container)).toContain('Book a carpet clean')
  expect(container.textContent).not.toContain('something else entirely')
})

test('Escape on an emptied existing row keeps the row', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /flat/i)

  // Clearing the field and hitting Escape is a cancelled edit, not a deletion —
  // the row existed before you started typing.
  const input = editRow(container, /Book a carpet clean/)
  act(() => fireEvent.change(input, { target: { value: '' } }))
  escapeAndBlur(input)

  expect(labels(container)).toContain('Book a carpet clean')
})
