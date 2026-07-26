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

/** Fold a row by clicking its collapse caret. */
function collapse(container: HTMLElement, text: RegExp) {
  const caret = row(container, text).querySelector('.twisty') as HTMLElement
  act(() => caret.click())
}

test('Tab into a collapsed sibling keeps the row on screen', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  // Fold the sibling above, so nesting into it would hide the row.
  collapse(container, /Gather the documents/)
  expect(labels(container)).not.toContain("Find last year's return PDF")

  // Tab the next top-level row into that folded sibling. It must not vanish.
  const input = editRow(container, /Fill in the forms/)
  act(() => fireEvent.keyDown(input, { key: 'Tab' }))

  expect(labels(container)).toContain('Fill in the forms')
})

test('Tab on a row between two parents nests it under the one above', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /tax/i)

  // A fresh row after "Gather the documents" — both the sibling above and the
  // one below ("Fill in the forms") have children of their own.
  const gather = editRow(container, /Gather the documents/)
  act(() => {
    fireEvent.change(gather, { target: { value: 'Gather the documents' } })
    fireEvent.keyDown(gather, { key: 'Enter' })
  })
  const fresh = container.querySelector('input.label-input') as HTMLInputElement
  act(() => fireEvent.change(fresh, { target: { value: 'Check the deadline' } }))
  act(() => fireEvent.keyDown(fresh, { key: 'Tab' }))

  // It stays on screen, and lands as the last child of the row above rather
  // than anywhere near the row below.
  const rows = labels(container)
  expect(rows).toContain('Check the deadline')
  expect(rows.indexOf('Check the deadline')).toBe(rows.indexOf('Dig out the P60') + 1)
})
