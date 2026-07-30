import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { seedTree } from '@shared/seed'

// Editing is local-first, so none of this needs the server. Stub the write path
// and the SSE stream so the component mounts without reaching for either.
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

// Rows only render once scoped into a project.
function scopeInto(container: HTMLElement, name: RegExp) {
  const card = [...container.querySelectorAll('button.proj')].find((b) =>
    name.test(b.textContent ?? ''),
  ) as HTMLElement
  act(() => card.click())
}

/**
 * The visible row labels, top to bottom. A row being edited shows an input
 * rather than its label, so read that instead — otherwise the row's other
 * glyphs (the collapse caret) come back as its text.
 */
function labels(container: HTMLElement) {
  return [...container.querySelectorAll('.row')].map((r) => {
    const input = r.querySelector('input.label-input') as HTMLInputElement | null
    return input ? input.value : (r.querySelector('.label')?.textContent ?? '').trim()
  })
}

/** Click a row's label to start editing it, and hand back its input. */
function editRow(container: HTMLElement, text: RegExp): HTMLInputElement {
  const row = [...container.querySelectorAll('.row')].find((r) => text.test(r.textContent ?? ''))!
  act(() => (row.querySelector('.label') as HTMLElement).click())
  return container.querySelector('input.label-input') as HTMLInputElement
}

test('Enter opens the new row directly below the one being edited', async () => {
  const { default: Outliner } = await import('./Outliner')
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /flat/i)

  expect(labels(container)).toEqual([
    'Email the landlord about the boiler',
    'Book a carpet clean',
    'Replace the hallway bulb',
  ])

  // Enter on the *first* of three siblings. Appending would drop the new row
  // at the bottom, far from where the caret was.
  const input = editRow(container, /Email the landlord/)
  act(() => {
    fireEvent.change(input, { target: { value: 'Email the landlord about the boiler' } })
    fireEvent.keyDown(input, { key: 'Enter' })
  })

  expect(labels(container)).toEqual([
    'Email the landlord about the boiler',
    '', // the fresh row, still empty and in edit mode
    'Book a carpet clean',
    'Replace the hallway bulb',
  ])
})

test('Enter on the last row still appends', async () => {
  const { default: Outliner } = await import('./Outliner')
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /flat/i)

  const input = editRow(container, /Replace the hallway bulb/)
  act(() => {
    fireEvent.change(input, { target: { value: 'Replace the hallway bulb' } })
    fireEvent.keyDown(input, { key: 'Enter' })
  })

  expect(labels(container)).toEqual([
    'Email the landlord about the boiler',
    'Book a carpet clean',
    'Replace the hallway bulb',
    '',
  ])
})

test('Enter on a never-named project backs out instead of leaving an Untitled one', async () => {
  const { default: Outliner } = await import('./Outliner')
  const { container } = render(<Outliner initial={seedTree()} />)

  const add = [...container.querySelectorAll('button')].find((b) =>
    /new project/i.test(b.textContent ?? ''),
  ) as HTMLElement
  act(() => add.click())
  // The title is genuinely empty while being edited — "Untitled" is drawn by
  // CSS, so it can't be mistaken for a name that was typed.
  expect(container.querySelector('h1')?.textContent).toBe('')

  // The title is in edit mode and still blank. Enter here should abandon the
  // project, not commit it with an empty name and a blank first row.
  const title = container.querySelector('h1[contenteditable="true"]') as HTMLElement
  // jsdom leaves isContentEditable false whatever the attribute says, which
  // would let the window-level "Enter adds a task" shortcut fire on a keypress
  // the real browser routes only to the title.
  Object.defineProperty(title, 'isContentEditable', { value: true })
  act(() => fireEvent.keyDown(title, { key: 'Enter' }))

  // Back out to the projects list, with no half-made project left behind.
  expect(container.querySelector('h1')?.textContent).toBe('Projects')
  expect(container.textContent).not.toContain('Untitled')
})

test('blurring a never-typed empty row removes it rather than stranding one', async () => {
  const { default: Outliner } = await import('./Outliner')
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /flat/i)

  // Spawn a fresh empty sibling, then leave it without typing anything —
  // clicking away, zooming into another row, or starting a drag all blur the
  // input the same way. The stored text of a just-made row is already '', so a
  // commit that treats "empty and unchanged" as a no-op would keep it.
  const first = editRow(container, /Book a carpet clean/)
  act(() => {
    fireEvent.change(first, { target: { value: 'Book a carpet clean' } })
    fireEvent.keyDown(first, { key: 'Enter' })
  })
  const blank = container.querySelector('input.label-input') as HTMLInputElement
  act(() => fireEvent.blur(blank, { target: { value: '' } }))

  expect(labels(container)).toEqual([
    'Email the landlord about the boiler',
    'Book a carpet clean',
    'Replace the hallway bulb',
  ])
})

test('Cmd+D toggles the edited row done while keeping it in edit mode', async () => {
  const { default: Outliner } = await import('./Outliner')
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /flat/i)

  const rowOf = (input: HTMLElement) => input.closest('.row') as HTMLElement
  const input = editRow(container, /Book a carpet clean/)
  expect(rowOf(input).classList.contains('done')).toBe(false)

  // Ticking it off mid-edit must not drop out of edit mode or lose typed text.
  act(() => {
    fireEvent.change(input, { target: { value: 'Book a deep carpet clean' } })
    fireEvent.keyDown(input, { key: 'd', metaKey: true })
  })

  const stillEditing = container.querySelector('input.label-input') as HTMLInputElement
  expect(stillEditing).not.toBeNull()
  expect(stillEditing.value).toBe('Book a deep carpet clean')
  expect(rowOf(stillEditing).classList.contains('done')).toBe(true)

  // And it toggles back.
  act(() => fireEvent.keyDown(stillEditing, { key: 'd', metaKey: true }))
  expect(rowOf(stillEditing).classList.contains('done')).toBe(false)
})

test('Cmd+Enter commits the row and exits without spawning an empty sibling', async () => {
  const { default: Outliner } = await import('./Outliner')
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /flat/i)

  // Finishing a task with Cmd+Enter should save it and drop straight out of
  // edit mode — no trailing empty row to dismiss with a second Enter.
  const input = editRow(container, /Book a carpet clean/)
  act(() => {
    fireEvent.change(input, { target: { value: 'Book the carpet clean' } })
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
  })

  expect(container.querySelector('input.label-input')).toBeNull()
  expect(labels(container)).toEqual([
    'Email the landlord about the boiler',
    'Book the carpet clean',
    'Replace the hallway bulb',
  ])
})

test('Enter on an empty row removes it rather than leaving an untitled one', async () => {
  const { default: Outliner } = await import('./Outliner')
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeInto(container, /flat/i)

  // Make a fresh empty row, then press Enter again without typing into it.
  const first = editRow(container, /Book a carpet clean/)
  act(() => {
    fireEvent.change(first, { target: { value: 'Book a carpet clean' } })
    fireEvent.keyDown(first, { key: 'Enter' })
  })
  const blank = container.querySelector('input.label-input') as HTMLInputElement
  act(() => fireEvent.keyDown(blank, { key: 'Enter' }))

  // The empty row is gone, and no 'Untitled' placeholder was left behind.
  expect(labels(container)).toEqual([
    'Email the landlord about the boiler',
    'Book a carpet clean',
    'Replace the hallway bulb',
  ])
})
