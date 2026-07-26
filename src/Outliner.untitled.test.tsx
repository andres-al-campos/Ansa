import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { seedTree } from '@shared/seed'
import Outliner from './Outliner'

// Editing is local-first, so none of this needs the server.
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

/** Names on the project landing cards. */
function projects(container: HTMLElement) {
  return [...container.querySelectorAll('button.proj')].map((b) => b.textContent ?? '')
}

/**
 * Start a new project and hand back its title element, mid-edit and unnamed.
 *
 * jsdom leaves isContentEditable false whatever the attribute says, which would
 * let the window-level "Enter adds a task" shortcut fire on keypresses the real
 * browser routes only to the title. Set it so the test exercises the real path.
 */
function startNewProject(container: HTMLElement) {
  const add = [...container.querySelectorAll('button')].find((b) =>
    /new project/i.test(b.textContent ?? ''),
  ) as HTMLElement
  act(() => add.click())
  const title = container.querySelector('h1[contenteditable="true"]') as HTMLElement
  Object.defineProperty(title, 'isContentEditable', { value: true })
  return title
}

test('blurring a never-named project leaves no Untitled behind', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  const before = projects(container)
  const title = startNewProject(container)

  // Clicking anywhere else — the sidebar, another card — blurs the title. The
  // project was never named, so it should go the same way Escape sends it.
  expect(title.textContent).toBe('')
  act(() => fireEvent.blur(title))

  expect(projects(container)).toEqual(before)
})

test('navigating away from a never-named project drops it', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  const before = projects(container)
  startNewProject(container)

  // No keypress and no blur — just clicking the wordmark to go home. This is
  // the route that stranded an "Untitled" card, since nothing about the title
  // was ever touched.
  const home = [...container.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === 'Ansa',
  ) as HTMLElement
  act(() => home.click())

  expect(projects(container)).toEqual(before)
})

test('a half-filled project survives being navigated away from', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  const title = startNewProject(container)

  // Named but empty: you meant to make this, so leaving must not bin it.
  act(() => {
    title.textContent = 'Groceries'
    fireEvent.input(title)
    fireEvent.keyDown(title, { key: 'Enter' })
  })
  const home = [...container.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === 'Ansa',
  ) as HTMLElement
  act(() => home.click())

  expect(projects(container).some((p) => /Groceries/.test(p))).toBe(true)
})

test('a project genuinely named Untitled is kept', () => {
  const { container } = render(<Outliner initial={seedTree()} />)
  const title = startNewProject(container)

  // The placeholder reads "Untitled" too, but this one was actually typed. It
  // has to survive, or the name becomes unusable.
  act(() => {
    title.textContent = 'Untitled'
    fireEvent.input(title)
    fireEvent.keyDown(title, { key: 'Enter' })
  })

  expect(projects(container).some((p) => /Untitled/.test(p))).toBe(true)
})
