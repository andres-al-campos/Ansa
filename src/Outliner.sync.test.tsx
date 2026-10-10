import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { clerkMock } from './testClerk'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { seedTree } from '@shared/seed'
import { applyOp, type Op } from '@shared/ops'
import { fingerprint, type Tree } from '@shared/tree'
import type { WriteResult } from './api'

// Spy on the write path. Everything else in the api module (eventsUrl, ORIGIN)
// stays real so the component wires up exactly as in the app.
const sendOp = vi.fn(async (_op: Op): Promise<WriteResult> => ({ status: 'ok' }))
const putTree = vi.fn(async (_tree: Tree) => true)
// The recovery path. Null by default — "could not reach the server" — so a
// test has to say what the server holds before a refetch can adopt anything.
const fetchTree = vi.fn(async (): Promise<Tree | null> => null)

/** The op names sent so far, in order. */
const sentOps = () => sendOp.mock.calls.map(([op]) => op.op)
vi.mock('@clerk/clerk-react', () => clerkMock())
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return { ...actual, sendOp, putTree, fetchTree }
})

// A fake WebSocket we drive by hand, so the test decides precisely when the
// server's first (authoritative) tree arrives.
let live: FakeSocket | null = null
// Every socket the component has opened, in order. Reconnection is "a second
// entry appears", so the count is the assertion.
let opened: FakeSocket[] = []
class FakeSocket {
  onmessage: ((e: { data: string }) => void) | null = null
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  // What the client sent us — the hello frame carrying this tab's origin tag.
  sent: string[] = []
  constructor(public url: string) {
    live = this
    opened.push(this)
  }
  send(payload: string) {
    this.sent.push(payload)
  }
  close() {
    this.closed = true
  }
  // Push a server broadcast to the component: the whole tree, as the first
  // frame on a socket and every write with no op form is.
  emit(tree: Tree, origin: string | null = null) {
    this.onmessage?.({ data: JSON.stringify({ kind: 'tree', tree, origin, hash: fingerprint(tree) }) })
  }
  // An op frame, stamped with the fingerprint of `after` — the server's tree
  // once it applied the op.
  emitOp(op: Op, after: Tree, origin: string | null = null) {
    this.onmessage?.({ data: JSON.stringify({ kind: 'op', op, origin, hash: fingerprint(after) }) })
  }
  // The server (or the platform) dropping this connection.
  drop() {
    this.closed = true
    this.onclose?.()
  }
}

beforeEach(() => {
  // Reset, not clear: several tests install a persistent answer (unreachable,
  // rejected) and the next test must start from a server that accepts.
  sendOp.mockReset()
  sendOp.mockResolvedValue({ status: 'ok' })
  putTree.mockClear()
  fetchTree.mockReset()
  fetchTree.mockResolvedValue(null)
  live = null
  opened = []
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket)
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// The stream URL is now fetched asynchronously (the Clerk token has to be
// awaited), so the socket is constructed a microtask after render rather than
// during it. Flush that before any test reaches for `live`.
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

// Click a row's label to edit it, returning its input.
function editRow(container: HTMLElement, text: RegExp): HTMLInputElement {
  const row = [...container.querySelectorAll('.row')].find((r) => text.test(r.textContent ?? ''))!
  act(() => (row.querySelector('.label') as HTMLElement).click())
  return container.querySelector('input.label-input') as HTMLInputElement
}

// The input of whichever row is currently being edited (the fresh one after Enter).
function editing(container: HTMLElement) {
  return container.querySelector('input.label-input') as HTMLInputElement
}

test('an edit before the first sync is held, then sent once the server tree lands', async () => {
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

  // The server's authoritative tree arrives over the socket. The held ops are now safe
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

test('an edit made before the first tree stays on screen when the tree lands', async () => {
  // The first tree is adopted even mid-edit, and it cannot hold what this tab
  // has not sent yet. Adopted bare, it unticks the box the user just ticked
  // while the setDone that ticked it is still in the queue.
  const { default: Outliner } = await import('./Outliner')
  const seed = seedTree()
  const { container } = render(<Outliner initial={seed} />)
  const stream = await streamOpen()
  scopeIntoProject(container)
  toggleFirstTask(container)
  const box = () => container.querySelector('[role="checkbox"]') as HTMLElement
  expect(box().getAttribute('aria-checked')).toBe('true')

  await act(async () => {
    stream.emit(seed)
  })

  expect(box().getAttribute('aria-checked')).toBe('true')
  expect(sentOps()).toEqual(['markOpened', 'setDone'])
})

test('a project being named when the first tree lands is kept, and is created with its name', async () => {
  // The drive flake this pins: "+ New project" is on screen from the cache
  // before the socket's first frame, so a fast hand (or a slow server) is
  // typing the name when the tree arrives. The unnamed project is held off the
  // wire, so the server's tree has no trace of it.
  const { default: Outliner } = await import('./Outliner')
  const seed = seedTree()
  const { container } = render(<Outliner initial={seed} />)
  const stream = await streamOpen()
  const add = [...container.querySelectorAll('button')].find((b) => /New project/.test(b.textContent ?? ''))!
  act(() => add.click())
  const title = () => container.querySelector('h1.scope-title') as HTMLElement
  expect(title().isContentEditable || title().getAttribute('contenteditable') === 'true').toBe(true)
  title().textContent = 'Half a na'

  await act(async () => {
    stream.emit(seed)
  })

  expect(
    title().getAttribute('contenteditable'),
    'adopting the first tree closed the name being typed',
  ).toBe('true')
  title().textContent = 'Half a name, finished'
  await act(async () => {
    fireEvent.keyDown(title(), { key: 'Enter' })
  })
  const added = sendOp.mock.calls.map(([op]) => op).filter((op) => op.op === 'addChild')
  expect(added.map((op) => ('text' in op ? op.text : ''))).toEqual(['Half a name, finished'])
  expect(title().textContent).toBe('Half a name, finished')
})

test('the socket is receive-only', async () => {
  // Nothing may travel client-to-server here. The socket handshake is the only
  // place a Clerk token is checked, so a write accepted over an already-open
  // socket would skip the per-request auth the fetch handler does. Ops go over
  // HTTP for that reason, and this asserts the rule stays true.
  const { default: Outliner } = await import('./Outliner')
  const seed = seedTree()
  const { container } = render(<Outliner initial={seed} />)
  const stream = await streamOpen()

  await act(async () => {
    stream.onopen?.()
  })
  scopeIntoProject(container)
  await act(async () => {
    stream.emit(seed)
  })
  await act(async () => {
    toggleFirstTask(container)
  })

  expect(stream.sent).toEqual([])
  expect(sendOp).toHaveBeenCalled()
})

// The reconnect is a setTimeout followed by an awaited token, so both a timer
// flush and a microtask flush are needed before the new socket exists.
async function flushReconnect() {
  await act(async () => {
    vi.advanceTimersByTime(60_000)
  })
  await act(async () => {})
}

test('a dropped socket is reopened, so the tab keeps receiving changes', async () => {
  // The bug this guards: writes go over HTTP and keep working after the socket
  // dies, so a deaf tab looks healthy. It saves fine, receives nothing, and two
  // tabs silently diverge until one is reloaded. On Cloudflare drops are normal
  // — the Durable Object hibernates idle sockets and the token in the handshake
  // URL expires in about a minute — so not reconnecting means not syncing.
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const { default: Outliner } = await import('./Outliner')
  const seed = seedTree()
  render(<Outliner initial={seed} />)
  const first = await streamOpen()

  await act(async () => {
    first.drop()
  })
  await flushReconnect()

  expect(opened.length).toBe(2)
  const second = opened[1]
  expect(second).not.toBe(first)

  // The reopened socket is a working one, not just an object that exists: a
  // broadcast over it has to reach the component. A tree with a distinct project
  // name makes arrival visible in the rendered output.
  const replacement = seed.map((n) =>
    n.parentId === null ? { ...n, text: 'Arrived after reconnect' } : n,
  )
  await act(async () => {
    second.onopen?.()
    second.emit(replacement)
  })
  expect(document.body.textContent).toContain('Arrived after reconnect')
})

test('a reconnect fetches a fresh URL rather than replaying the expired one', async () => {
  // The handshake URL carries a short-lived Clerk token. Reusing the original
  // would reconnect with a stale credential and be refused — a reconnect that
  // exists but never succeeds, which is indistinguishable from no reconnect.
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const { default: Outliner } = await import('./Outliner')
  render(<Outliner initial={seedTree()} />)
  const first = await streamOpen()

  await act(async () => {
    first.drop()
  })
  await flushReconnect()

  // eventsUrl() is the only thing that can mint a URL, so a second socket at all
  // means it was called again rather than the first URL being cached.
  expect(opened.length).toBe(2)
  expect(typeof opened[1].url).toBe('string')
})

test('unmounting closes the socket and never reopens it', async () => {
  // A reconnect after unmount would resurrect the socket for a component that
  // no longer exists — a leak that survives every navigation and keeps adopting
  // trees into nothing.
  //
  // Two things in the effect prevent it: the `cancelled` flag, and detaching
  // onclose/onerror before calling close(). Either alone is sufficient today,
  // so this asserts the observable outcome rather than one mechanism. A late
  // drop is delivered explicitly, because close() on the fake doesn't fire
  // onclose by itself — without that the test would pass on an implementation
  // with no guard at all.
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const { default: Outliner } = await import('./Outliner')
  const { unmount } = render(<Outliner initial={seedTree()} />)
  const socket = await streamOpen()

  unmount()
  expect(socket.closed).toBe(true)

  // The platform dropping the connection after unmount, which is the ordering a
  // real close produces.
  await act(async () => {
    socket.onclose?.()
    socket.onerror?.()
  })
  await flushReconnect()

  expect(opened.length).toBe(1)
})

// Drop the socket `times` times, letting each reconnect attempt complete.
async function dropRepeatedly(times: number) {
  for (let i = 0; i < times; i++) {
    const socket = opened[opened.length - 1]
    await act(async () => {
      socket.drop()
    })
    await flushReconnect()
  }
}

test('a single drop does not warn, because reconnects usually succeed', async () => {
  // The flicker guard. Hibernation, a sleeping laptop and a wifi blip all drop
  // the socket during normal use, and warning on each one trains people to
  // ignore the toast — which then says nothing when sync is really broken.
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const { default: Outliner } = await import('./Outliner')
  const { container } = render(<Outliner initial={seedTree()} />)
  await streamOpen()

  await dropRepeatedly(1)

  expect(container.querySelector('.sync-toast')).toBeNull()
})

test('repeated failures warn that this tab is no longer receiving changes', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const { default: Outliner } = await import('./Outliner')
  const { container } = render(<Outliner initial={seedTree()} />)
  await streamOpen()

  await dropRepeatedly(3)

  const toast = container.querySelector('.sync-toast')
  expect(toast).not.toBeNull()
  // Writes still land over HTTP, so the message must not read as data loss.
  expect(toast?.textContent).toMatch(/changes are saved/i)
})

test('a recovered connection clears the warning', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const { default: Outliner } = await import('./Outliner')
  const { container } = render(<Outliner initial={seedTree()} />)
  await streamOpen()

  await dropRepeatedly(3)
  expect(container.querySelector('.sync-toast')).not.toBeNull()

  // The next attempt connects.
  await act(async () => {
    opened[opened.length - 1].onopen?.()
  })
  expect(container.querySelector('.sync-toast')).toBeNull()
})

test('dismissing hides the warning until sync fails again', async () => {
  // Dismissal covers this outage only: a drop after a working period is new
  // information, and a permanently silenced warning is the bug this replaces.
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const { default: Outliner } = await import('./Outliner')
  const { container } = render(<Outliner initial={seedTree()} />)
  await streamOpen()

  await dropRepeatedly(3)
  const close = container.querySelector('.sync-toast-close') as HTMLElement
  await act(async () => {
    close.click()
  })
  expect(container.querySelector('.sync-toast')).toBeNull()

  // Recover, then fail again — the toast has to come back.
  await act(async () => {
    opened[opened.length - 1].onopen?.()
  })
  await dropRepeatedly(3)
  expect(container.querySelector('.sync-toast')).not.toBeNull()
})

test('a rejected op does not block every edit made after it', async () => {
  // The stall this guards against: drain() stops at the first op the server
  // won't take and leaves it at the head of the queue. A 400 means the server
  // looked at that op and refused it, so retrying is futile — but the queue
  // retries anyway, and every later edit sits behind it forever. The tab keeps
  // working, localStorage keeps the tree, and nothing reaches the server again.
  // A rejection is logged deliberately (a malformed op is a client bug worth
  // seeing), so the expected noise is silenced rather than left to look like a
  // test failure.
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  const { default: Outliner } = await import('./Outliner')
  const seed = seedTree()
  const { container } = render(<Outliner initial={seed} />)
  const stream = await streamOpen()
  scopeIntoProject(container)
  await act(async () => {
    stream.emit(seed)
  })

  // The next op is refused *persistently*. A 400 is a verdict on that specific
  // op, so the server returns it every time the op is offered — unlike a network
  // failure, waiting changes nothing.
  const from = sendOp.mock.calls.length
  let poison: Op | null = null
  sendOp.mockImplementation(async (op: Op): Promise<WriteResult> => {
    poison ??= op
    // The shape a lost race produces: the parent was deleted on another device,
    // so this op can never be stored no matter how often it is offered.
    return op === poison
      ? { status: 'rejected', reason: 'No node with id x in this tree.' }
      : { status: 'ok' }
  })

  // The edit the server refuses, then two good edits behind it.
  await act(async () => {
    toggleFirstTask(container)
  })
  await act(async () => {
    toggleFirstTask(container)
  })
  await act(async () => {
    toggleFirstTask(container)
  })

  // Only the poison op is ever offered: the good edits behind it are never
  // attempted at all, so nothing the user does after this point reaches the
  // server.
  const attempted = sendOp.mock.calls.slice(from).map(([op]) => op)
  const reachedServer = attempted.filter((op) => op !== poison)
  expect(reachedServer.length).toBeGreaterThan(0)

  // The refused op is offered exactly once. Retrying it would be the stall.
  expect(attempted.filter((op) => op === poison)).toHaveLength(1)
  expect(logged).toHaveBeenCalled()
  logged.mockRestore()
})

test('a queue stalled by an unreachable server retries without another edit', async () => {
  // Otherwise the only thing that retries is the next send(), so a tab whose
  // last edit failed keeps it forever if the user stops typing — saved locally,
  // absent from the server, and looking perfectly healthy. Same shape as the
  // deaf socket: silence that reads as success.
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const { default: Outliner } = await import('./Outliner')
  const seed = seedTree()
  const { container } = render(<Outliner initial={seed} />)
  const stream = await streamOpen()
  scopeIntoProject(container)
  await act(async () => {
    stream.emit(seed)
  })

  sendOp.mockResolvedValue({ status: 'unreachable' })
  await act(async () => {
    toggleFirstTask(container)
  })
  const whileDown = sendOp.mock.calls.length

  // The server comes back. Nothing else happens — no keystroke, no click.
  sendOp.mockResolvedValue({ status: 'ok' })
  await act(async () => {
    vi.advanceTimersByTime(6_000)
  })
  await act(async () => {})

  expect(sendOp.mock.calls.length).toBeGreaterThan(whileDown)
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

test('a row opened and abandoned empty never reaches the server', async () => {
  // The empty-placeholder bug: the web app used to broadcast a blank addChild the
  // instant a row was born, so a peer mid-edit (iOS stashes incoming trees while
  // busy) would adopt the empty row and it lingered. A row you open and never
  // type into is not a task — its create is withheld until it has real text, so
  // an abandoned one leaves no trace on the wire.
  const { default: Outliner } = await import('./Outliner')
  const seed = seedTree()
  const { container } = render(<Outliner initial={seed} />)
  const stream = await streamOpen()
  scopeIntoProject(container)
  await act(async () => {
    stream.emit(seed)
  })
  const before = sendOp.mock.calls.length

  // Enter to spawn a fresh empty row, then Enter again on it without typing —
  // the outliner's "abandon an empty row" gesture.
  const input = editRow(container, /Email the landlord/)
  act(() => {
    fireEvent.change(input, { target: { value: 'Email the landlord about the boiler' } })
    fireEvent.keyDown(input, { key: 'Enter' })
  })
  await act(async () => fireEvent.keyDown(editing(container), { key: 'Enter' }))

  // The committing setText for the row that was already there may go out; what
  // must not is any addChild — the abandoned row was never real.
  const added = sendOp.mock.calls.slice(before).filter(([op]) => op.op === 'addChild')
  expect(added).toEqual([])
})

test('a new row typed into is created once, already carrying its text', async () => {
  // The other half of the fix: withholding the empty create must not turn one
  // addChild into an empty addChild plus a later setText. The row's first real
  // text becomes the create, so it lands as a single named addChild — not a
  // blank node the server then has to rename.
  const { default: Outliner } = await import('./Outliner')
  const seed = seedTree()
  const { container } = render(<Outliner initial={seed} />)
  const stream = await streamOpen()
  scopeIntoProject(container)
  await act(async () => {
    stream.emit(seed)
  })
  const before = sendOp.mock.calls.length

  // Enter to spawn the row, type into it, then Enter to commit and move on.
  const input = editRow(container, /Email the landlord/)
  act(() => {
    fireEvent.change(input, { target: { value: 'Email the landlord about the boiler' } })
    fireEvent.keyDown(input, { key: 'Enter' })
  })
  const fresh = editing(container)
  await act(async () => {
    fireEvent.change(fresh, { target: { value: 'Ring the plumber' } })
    fireEvent.keyDown(fresh, { key: 'Enter' })
  })

  const added = sendOp.mock.calls
    .slice(before)
    .map(([op]) => op)
    .filter((op) => op.op === 'addChild')
    .map((op) => ({ op: op.op, text: 'text' in op ? op.text : undefined }))
  expect(added).toEqual([{ op: 'addChild', text: 'Ring the plumber' }])
  // And no stray setText for that same row — the text rode in on the create.
  const setTexts = sendOp.mock.calls
    .slice(before)
    .filter(([op]) => op.op === 'setText' && op.text === 'Ring the plumber')
  expect(setTexts).toEqual([])
})

test('a refused edit is shown to the user, and can be dismissed', async () => {
  // The console.error is for whoever is debugging; this is the half the user
  // sees. Without it the failure is silent in exactly the way that matters: the
  // edit is on screen, it feels saved, and it vanishes at the next adopt with no
  // explanation. The toast has to outrank the "not syncing" one, because that
  // one says changes are still being saved — true of deafness, a lie here.
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  const { default: Outliner } = await import('./Outliner')
  const seed = seedTree()
  const { container } = render(<Outliner initial={seed} />)
  const stream = await streamOpen()
  scopeIntoProject(container)
  await act(async () => {
    stream.emit(seed)
  })

  expect(container.querySelector('.sync-toast-warn')).toBeNull()

  sendOp.mockResolvedValue({ status: 'rejected', reason: 'No node with id x in this tree.' })
  await act(async () => {
    toggleFirstTask(container)
  })

  const toast = container.querySelector('.sync-toast-warn')
  expect(toast).not.toBeNull()
  expect(toast!.textContent).toMatch(/couldn't be saved/i)

  // Dismissable: the edit is already gone and nothing about it is actionable, so
  // a warning that cannot be cleared is just permanent furniture.
  const close = toast!.querySelector('.sync-toast-close') as HTMLElement
  await act(async () => {
    close.click()
  })
  expect(container.querySelector('.sync-toast-warn')).toBeNull()
  logged.mockRestore()
})

test("the node cap's own message is what the toast shows", async () => {
  // The generic wording guesses at a cause ("removed on another device") that
  // is wrong for this refusal and points nowhere. Being at the cap is a real
  // state of the outline with a real remedy, and only the server knows it, so
  // its words are the ones shown.
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  const { default: Outliner } = await import('./Outliner')
  const seed = seedTree()
  const { container } = render(<Outliner initial={seed} />)
  const stream = await streamOpen()
  scopeIntoProject(container)
  await act(async () => {
    stream.emit(seed)
  })

  sendOp.mockResolvedValue({
    status: 'rejected',
    reason:
      'That would put this outline over 5000 tasks, which is the limit. '
      + 'Delete something, or split a branch into its own project.',
  })
  await act(async () => {
    toggleFirstTask(container)
  })

  const toast = container.querySelector('.sync-toast-warn')
  expect(toast!.textContent).toMatch(/split a branch into its own project/)
  expect(toast!.textContent).not.toMatch(/removed on another device/)
  logged.mockRestore()
})

test('a queue left behind by a killed run is sent on the next one', async () => {
  // The scenario this exists for: edits made offline, then the tab closed (or
  // the phone app killed by the OS) before they could go out. The tree is in
  // localStorage but the ops are what tell the server about it, so losing them
  // means the server's next broadcast silently overwrites that work.
  localStorage.setItem(
    'ansa.queue.v1',
    JSON.stringify([{ op: 'setText', id: 'ghost', text: 'written before the crash' }]),
  )

  const { default: Outliner } = await import('./Outliner')
  const seed = seedTree()
  const { container } = render(<Outliner initial={seed} />)
  const stream = await streamOpen()
  scopeIntoProject(container)

  // Still held: a restored op is in exactly the same position as one made while
  // disconnected, so it waits for the real baseline like any other.
  expect(sendOp).not.toHaveBeenCalled()

  await act(async () => {
    stream.emit(seed)
  })

  // First out, ahead of the markOpened that scoping into the project queued
  // behind it — the restored ops are older, and order is the whole contract.
  expect(sendOp.mock.calls[0][0]).toEqual({
    op: 'setText',
    id: 'ghost',
    text: 'written before the crash',
  })
  expect(sentOps()).toEqual(['setText', 'markOpened'])
  // Delivered, so it must not be replayed again on the run after this one.
  expect(localStorage.getItem('ansa.queue.v1')).toBeNull()
})

test('opens where the last session left off, not on the project list', async () => {
  const { default: Outliner } = await import('./Outliner')
  // A cache that already knows the flat was the last thing worked on.
  const seed = seedTree()
  const flat = seed.find((n) => n.parentId === null && /flat/i.test(n.text))!
  const cached = seed.map((n) => (n.id === flat.id ? { ...n, lastOpenedAt: 5_000 } : n))

  const { container } = render(<Outliner initial={cached} />)
  await streamOpen()

  // Scoped in: task rows (checkboxes) are showing without anyone clicking a
  // project. On the home list there are none.
  expect(container.querySelector('[role="checkbox"]')).not.toBeNull()
})

test('the home list is still where an untouched tree lands', async () => {
  const { default: Outliner } = await import('./Outliner')
  const { container } = render(<Outliner initial={seedTree()} />)
  await streamOpen()
  expect(container.querySelector('[role="checkbox"]')).toBeNull()
  expect(container.querySelectorAll('button.proj').length).toBeGreaterThan(0)
})

test('the server tree corrects a resume guessed from an empty cache', async () => {
  const { default: Outliner } = await import('./Outliner')
  // A fresh device: nothing cached, so the mount-time guess is "home".
  const { container } = render(<Outliner initial={[]} />)
  const stream = await streamOpen()
  expect(container.querySelector('[role="checkbox"]')).toBeNull()

  // The account's real tree arrives, carrying where this user actually was.
  const seed = seedTree()
  const flat = seed.find((n) => n.parentId === null && /flat/i.test(n.text))!
  await act(async () => {
    stream.emit(seed.map((n) => (n.id === flat.id ? { ...n, lastOpenedAt: 5_000 } : n)))
  })

  expect(container.querySelector('[role="checkbox"]')).not.toBeNull()
})

test('adopting never yanks you out of a project you opened yourself', async () => {
  const { default: Outliner } = await import('./Outliner')
  const seed = seedTree()
  const { container } = render(<Outliner initial={seed} />)
  const stream = await streamOpen()

  // The user goes home deliberately — the one place a stale resume would be
  // most annoying to be dragged back out of.
  scopeIntoProject(container)
  const home = container.querySelector('button.brand') as HTMLElement
  await act(async () => {
    home.click()
  })
  expect(container.querySelector('[role="checkbox"]')).toBeNull()

  // A broadcast lands that would otherwise resume into a project.
  const flat = seed.find((n) => n.parentId === null && /flat/i.test(n.text))!
  await act(async () => {
    stream.emit(seed.map((n) => (n.id === flat.id ? { ...n, lastOpenedAt: 9_000 } : n)))
  })

  expect(container.querySelector('[role="checkbox"]')).toBeNull()
})

// Echo every op this tab has sent, as the server would, each stamped with
// `server`'s fingerprint. The fingerprint check waits for these: until the
// echo of its own op is back, a tab cannot know which side of that op the
// server's hash is on.
async function echoSent(stream: FakeSocket, server: Tree) {
  const { ORIGIN } = await import('./api')
  for (const [op] of sendOp.mock.calls) {
    await act(async () => {
      stream.emitOp(op, server, ORIGIN)
    })
  }
  sendOp.mockClear()
}

// A node visible once scoped into "Sort out the flat".
function taskIn(seed: Tree, text: RegExp) {
  const flat = seed.find((n) => n.parentId === null && /flat/i.test(n.text))!
  return seed.find((n) => n.parentId === flat.id && text.test(n.text))!
}

test('an op made elsewhere is applied, not adopted as a whole tree', async () => {
  // This is the wire change: the server sends the op and the fingerprint of
  // its result, and this tab is trusted to get there by applying it.
  const { default: Outliner } = await import('./Outliner')
  const seed = seedTree()
  const { container } = render(<Outliner initial={seed} />)
  const stream = await streamOpen()
  scopeIntoProject(container)
  await act(async () => {
    stream.emit(seed)
  })

  const target = taskIn(seed, /./)
  const op: Op = { op: 'setText', id: target.id, text: 'Renamed on the phone' }
  await act(async () => {
    stream.emitOp(op, applyOp(seed, op).tree, 'ios-1')
  })

  expect(container.textContent).toContain('Renamed on the phone')
  // Applying it produced no write of our own, and no refetch: the fingerprint
  // matched.
  expect(sentOps()).not.toContain('setText')
  expect(fetchTree).not.toHaveBeenCalled()
})

test('an op arriving mid-edit waits, and lands without losing the edit', async () => {
  const { default: Outliner } = await import('./Outliner')
  const seed = seedTree()
  const { container } = render(<Outliner initial={seed} />)
  const stream = await streamOpen()
  scopeIntoProject(container)
  await act(async () => {
    stream.emit(seed)
  })

  // Start editing one row.
  const rows = [...container.querySelectorAll('.row')]
  const mine = rows[0].textContent ?? ''
  const input = editRow(container, new RegExp(mine.slice(0, 8).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  act(() => {
    fireEvent.change(input, { target: { value: 'Typed here' } })
  })

  // Someone renames a different row while the input is open.
  const other = seed.find((n) => n.id !== rows[0].getAttribute('data-id') && n.parentId === taskIn(seed, /./).parentId)!
  const op: Op = { op: 'setText', id: other.id, text: 'Renamed meanwhile' }
  await act(async () => {
    stream.emitOp(op, applyOp(seed, op).tree, 'ios-1')
  })
  // Held: nothing yanked the input away.
  expect(container.querySelector('input.label-input')).not.toBeNull()
  expect(container.textContent).not.toContain('Renamed meanwhile')

  // Finish the edit. Both changes are now on screen.
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter' })
  })
  await act(async () => {
    fireEvent.keyDown(editing(container) ?? input, { key: 'Escape' })
  })
  expect(container.textContent).toContain('Typed here')
  expect(container.textContent).toContain('Renamed meanwhile')

  // The server echoes our rename, stamped with the tree holding both changes.
  // That echo is the last word, and it agrees with what is on screen.
  const { ORIGIN } = await import('./api')
  const ours = sendOp.mock.calls.map(([o]) => o).find((o) => o.op === 'setText')!
  await act(async () => {
    stream.emitOp(ours, applyOp(applyOp(seed, op).tree, ours).tree, ORIGIN)
  })
  expect(fetchTree).not.toHaveBeenCalled()
})

test('a fingerprint that disagrees refetches the tree', async () => {
  // The guarantee that makes op frames safe. If this tab applies an op and
  // does not end up where the server is, the next quiet moment notices and the
  // server's tree replaces ours.
  const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { default: Outliner } = await import('./Outliner')
  const seed = seedTree()
  const { container } = render(<Outliner initial={seed} />)
  const stream = await streamOpen()
  scopeIntoProject(container)
  await act(async () => {
    stream.emit(seed)
  })
  await echoSent(stream, seed)

  // The server applied something we cannot reconstruct from the op alone: the
  // frame's fingerprint is of a tree with a rename this tab never saw.
  const target = taskIn(seed, /./)
  const unseen: Op = { op: 'setText', id: target.id, text: 'Only the server has this' }
  const serverTree = applyOp(seed, unseen).tree
  fetchTree.mockResolvedValue(serverTree)
  const op: Op = { op: 'setDone', id: target.id, done: true }
  await act(async () => {
    stream.emitOp(op, applyOp(serverTree, op).tree, 'ios-1')
  })
  await act(async () => {})

  expect(fetchTree).toHaveBeenCalledTimes(1)
  expect(warned).toHaveBeenCalled()
  expect(container.textContent).toContain('Only the server has this')
  warned.mockRestore()
})

test('a fingerprint that agrees never refetches', async () => {
  // The check has to be quiet in the ordinary case or it costs a tree read on
  // every edit, which is what op frames exist to avoid.
  const { default: Outliner } = await import('./Outliner')
  const seed = seedTree()
  const { container } = render(<Outliner initial={seed} />)
  const stream = await streamOpen()
  scopeIntoProject(container)
  await act(async () => {
    stream.emit(seed)
  })
  await echoSent(stream, seed)
  let server = seed
  for (let i = 0; i < 3; i++) {
    const op: Op = { op: 'setText', id: taskIn(seed, /./).id, text: `v${i}` }
    server = applyOp(server, op).tree
    await act(async () => {
      stream.emitOp(op, server, 'ios-1')
    })
  }
  expect(fetchTree).not.toHaveBeenCalled()
})

test('a refused edit refetches the tree, so the screen stops showing it', async () => {
  // A refusal produces no frame: the server did nothing, so it broadcasts
  // nothing. Left alone, the edit stays on screen until some other device
  // writes. Refetching is the only thing that puts this tab straight.
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { default: Outliner } = await import('./Outliner')
  const seed = seedTree()
  const { container } = render(<Outliner initial={seed} />)
  const stream = await streamOpen()
  scopeIntoProject(container)
  await act(async () => {
    stream.emit(seed)
  })
  fetchTree.mockResolvedValue(seed)
  sendOp.mockResolvedValueOnce({ status: 'rejected', reason: 'No node with id x in this tree.' })

  const box = container.querySelector('[role="checkbox"]') as HTMLElement
  const before = box.getAttribute('aria-checked')
  await act(async () => {
    box.click()
  })
  await act(async () => {})

  expect(fetchTree).toHaveBeenCalledTimes(1)
  expect((container.querySelector('[role="checkbox"]') as HTMLElement).getAttribute('aria-checked')).toBe(before)
  vi.restoreAllMocks()
})

test('an op frame before the first tree is ignored', async () => {
  // There is nothing to apply it to that we trust, and the tree that follows
  // already includes it. Applying it to the cached tree could double-apply.
  const { default: Outliner } = await import('./Outliner')
  const seed = seedTree()
  const { container } = render(<Outliner initial={seed} />)
  const stream = await streamOpen()
  scopeIntoProject(container)

  const target = taskIn(seed, /./)
  const op: Op = { op: 'setText', id: target.id, text: 'Too early' }
  await act(async () => {
    stream.emitOp(op, applyOp(seed, op).tree, 'ios-1')
  })
  expect(container.textContent).not.toContain('Too early')
  expect(fetchTree).not.toHaveBeenCalled()
})

test('a frame from a server that predates fingerprints is still a tree', async () => {
  // Deploy order is clients first, so a new client has to read the old shape:
  // `{ tree, origin }` with no kind and no hash. It adopts, and skips the check
  // it cannot make.
  const { default: Outliner } = await import('./Outliner')
  const { container } = render(<Outliner initial={[]} />)
  const stream = await streamOpen()
  const seed = seedTree()
  await act(async () => {
    stream.onmessage?.({ data: JSON.stringify({ tree: seed, origin: null }) })
  })
  expect(container.querySelectorAll('button.proj').length).toBeGreaterThan(0)
  expect(fetchTree).not.toHaveBeenCalled()
})

test('going into a place stamps it; going back up stamps nothing', async () => {
  const { default: Outliner } = await import('./Outliner')
  const seed = seedTree()
  const byText = (t: RegExp) => seed.find((n) => t.test(n.text))!.id
  const { container } = render(<Outliner initial={seed} />)
  const stream = await streamOpen()
  await act(async () => {
    stream.emit(seed)
  })

  const proj = [...container.querySelectorAll('button.proj')].find((b) => /tax return/i.test(b.textContent ?? ''))!
  await act(async () => (proj as HTMLElement).click())
  const zoom = container.querySelector('[aria-label="Zoom into Gather the documents"]') as HTMLElement
  await act(async () => zoom.click())
  // Up to the project by its breadcrumb, then home: neither is a visit.
  const crumbs = () => [...container.querySelectorAll('nav.crumbs button')] as HTMLElement[]
  await act(async () => crumbs().find((b) => /tax return/i.test(b.textContent ?? ''))!.click())
  await act(async () => crumbs().find((b) => b.textContent === 'Projects')!.click())

  const stamped = sendOp.mock.calls.map(([op]) => op).filter((op) => op.op === 'markOpened')
  expect(stamped.map((op) => 'id' in op && op.id)).toEqual([byText(/tax return/), byText(/Gather the documents/)])
})
