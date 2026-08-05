import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { seedTree } from '@shared/seed'
import type { Op } from '@shared/ops'
import type { Tree } from '@shared/tree'

// Spy on the write path. Everything else in the api module (eventsUrl, ORIGIN)
// stays real so the component wires up exactly as in the app.
const sendOp = vi.fn(async (_op: Op) => true)
const putTree = vi.fn(async (_tree: Tree) => true)

/** The op names sent so far, in order. */
const sentOps = () => sendOp.mock.calls.map(([op]) => op.op)
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return { ...actual, sendOp, putTree }
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
  sendOp.mockClear()
  putTree.mockClear()
  live = null
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource)
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// The stream URL is now fetched asynchronously (the Clerk token has to be
// awaited), so the EventSource is constructed a microtask after render rather
// than during it. Flush that before any test reaches for `live`.
async function streamOpen() {
  await act(async () => {})
  return live!
}

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

test('an edit before the first SSE sync is held, then sent once the server tree lands', async () => {
  const { default: Outliner } = await import('./Outliner')
  // One tree, rendered and then echoed back: the scenario is the server
  // confirming the tree this client already holds. Two separate seedTree() calls
  // would be two *different* trees — the seed mints fresh ids each call — which
  // is a wholesale replacement, not a sync.
  const seed = seedTree()
  const { container } = render(<Outliner initial={seed} />)
  const stream = await streamOpen()
  scopeIntoProject(container)

  // The stale-cache trap: the edit lands before the server's tree has been
  // adopted, so we don't yet know the real baseline. Nothing goes out.
  toggleFirstTask(container)
  expect(sendOp).not.toHaveBeenCalled()

  // The server's authoritative tree arrives over SSE. The held ops are now safe
  // to replay on top of it — they're kept, not dropped, and they go out in the
  // order they were made. Opening the project is itself a change (it stamps the
  // project as visited), so it queues ahead of the edit.
  await act(async () => {
    stream.emit(seed)
  })
  expect(sentOps()).toEqual(['markOpened', 'setDone'])

  // Later edits go out as they happen.
  await act(async () => {
    toggleFirstTask(container)
  })
  expect(sentOps()).toEqual(['markOpened', 'setDone', 'setDone'])
})

test('the whole tree is never pushed for an ordinary edit', async () => {
  const { default: Outliner } = await import('./Outliner')
  const seed = seedTree()
  const { container } = render(<Outliner initial={seed} />)
  const stream = await streamOpen()
  scopeIntoProject(container)

  await act(async () => {
    stream.emit(seed)
  })
  await act(async () => {
    toggleFirstTask(container)
  })

  // The regression guard: a whole-tree write is what made two clients editing at
  // once clobber each other. Edits must travel as ops.
  expect(putTree).not.toHaveBeenCalled()
  expect(sendOp).toHaveBeenCalled()
})
