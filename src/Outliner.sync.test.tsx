import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { seedTree } from '@shared/seed'
import type { Tree } from '@shared/tree'

// Spy on the one write path. Everything else in the api module (EVENTS_URL,
// ORIGIN) stays real so the component wires up exactly as in the app.
const putTree = vi.fn(async () => true)
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return { ...actual, putTree }
})

// A fake EventSource we drive by hand, so the test decides precisely when the
// server's first (authoritative) tree arrives.
let live: FakeEventSource | null = null
class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null
  constructor(public url: string) {
    live = this
  }
  close() {}
  // Push a server broadcast to the component.
  emit(tree: Tree, origin: string | null = null) {
    this.onmessage?.({ data: JSON.stringify({ tree, origin }) })
  }
}

beforeEach(() => {
  putTree.mockClear()
  live = null
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource)
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// The home view lists projects; task rows (with checkboxes) only appear once
// scoped into one. Click into "Sort out the flat" so real rows render.
function scopeIntoProject(container: HTMLElement) {
  const projects = [...container.querySelectorAll('button.proj')] as HTMLElement[]
  const flat = projects.find((b) => /flat/i.test(b.textContent ?? ''))!
  act(() => flat.click())
}

// Toggle a task's done state by clicking its checkbox — a genuine local edit
// that runs the persist effect.
function toggleFirstTask(container: HTMLElement) {
  const box = container.querySelector('[role="checkbox"]') as HTMLElement
  act(() => box.click())
}

test('a local edit before the first SSE sync is not pushed to the server', async () => {
  const { default: Outliner } = await import('./Outliner')
  const { container } = render(<Outliner initial={seedTree()} />)
  scopeIntoProject(container)

  // The stale-cache trap: edit lands before the server's tree has been adopted.
  // A whole-tree PUT here could wipe server nodes this tab has never seen, so it
  // must be suppressed.
  toggleFirstTask(container)
  expect(putTree).not.toHaveBeenCalled()

  // The server's authoritative tree arrives over SSE. This is the baseline the
  // tab adopts; from here writes are safe.
  act(() => live!.emit(seedTree()))

  // A later edit does persist.
  toggleFirstTask(container)
  expect(putTree).toHaveBeenCalledTimes(1)
})
