import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { seedTree } from '@shared/seed'
import type { Op } from '@shared/ops'
import type { Tree } from '@shared/tree'
import type { WriteResult } from './api'

// Spy on the write path. Everything else in the api module (eventsUrl, ORIGIN)
// stays real so the component wires up exactly as in the app.
const sendOp = vi.fn(async (_op: Op): Promise<WriteResult> => ({ status: 'ok' }))
const putTree = vi.fn(async (_tree: Tree) => true)

/** The op names sent so far, in order. */
const sentOps = () => sendOp.mock.calls.map(([op]) => op.op)
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return { ...actual, sendOp, putTree }
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
  // Push a server broadcast to the component.
  emit(tree: Tree, origin: string | null = null) {
    this.onmessage?.({ data: JSON.stringify({ tree, origin }) })
  }
  // The server (or the platform) dropping this connection.
  drop() {
    this.closed = true
    this.onclose?.()
  }
}

beforeEach(() => {
  sendOp.mockClear()
  putTree.mockClear()
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
