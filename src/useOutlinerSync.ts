/**
 * Keeping this tab and the server in step.
 *
 * The app is local-first: an edit applies to the in-memory tree immediately, so
 * undo/redo and the animations never wait on a round-trip. This hook is what
 * happens after that — it ships the operation to the server and adopts changes
 * coming back the other way.
 *
 * Three problems it exists to solve, all of them about timing:
 *
 *  - **Ordering.** Ops go out one at a time, in the order they were made. Two
 *    ops fired from one handler (rename, then add a sibling) must reach the
 *    server in that order or the second lands against a tree missing the first.
 *
 *  - **The stale cache.** First paint comes from localStorage, which may be
 *    older than the server. Until the authoritative tree has been adopted at
 *    least once, ops are held rather than sent: replaying them onto the server's
 *    real tree afterwards is right, but sending them while we're still guessing
 *    at the baseline is not.
 *
 *  - **Interruption.** An incoming tree must not be swapped in while the user is
 *    mid-edit or mid-drag, so it's stashed and adopted the moment they're idle.
 *
 *  - **Deafness.** A dropped socket is never noticed on its own, because writes
 *    go over HTTP and keep working. The tab saves fine and silently stops
 *    receiving, so two tabs diverge and whoever wrote last appears to win. This
 *    is why the socket reconnects rather than being opened once.
 *
 * That last one only became reachable on Cloudflare. The old SSE server held a
 * connection open indefinitely and EventSource reconnected by itself; a Durable
 * Object deliberately hibernates idle sockets to stay inside the free tier, and
 * the Clerk token in the handshake URL expires in about a minute. So drops are
 * routine here, and recovering from one is the client's job.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Op } from '@shared/ops'
import type { Tree } from '@shared/tree'
import { eventsUrl, ORIGIN, sendOp } from './api'

// Reconnect delay, doubling from the first to the second on repeated failure.
// The floor is short because the common case is a healthy tab whose socket was
// dropped by the platform, and a second of deafness is already visible. The
// ceiling keeps a tab that's been offline for an hour from hammering the API.
const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 30_000

// Consecutive failed reconnects before the tab is called out of sync. Not one:
// a single drop is ordinary — the object hibernates, a laptop sleeps, wifi
// blips — and the reconnect usually wins within a second. Warning on the first
// failure would flicker during normal use, which teaches people to ignore the
// one channel that matters when sync is genuinely broken.
const FAILURES_BEFORE_WARNING = 3

export interface OutlinerSync {
  /** Queue ops to send, in order. Applied locally by the caller already. */
  send: (...ops: Op[]) => void
  /**
   * False once the live connection has failed repeatedly.
   *
   * Only ever about *receiving*. Writes go over HTTP and are unaffected, which
   * is why the UI says changes are still saved — a blocked socket costs this
   * tab other people's edits, not its own.
   */
  live: boolean
}

export function useOutlinerSync({
  busy,
  onAdopt,
}: {
  /** True while the user is editing or dragging — don't yank the tree away. */
  busy: boolean
  /** Called with a server tree that should replace local state. */
  onAdopt: (tree: Tree) => void
}): OutlinerSync {
  // Whether the server's authoritative tree has been adopted at least once.
  // Until it has, queued ops stay put — see the stale-cache note above.
  const synced = useRef(false)
  // Ops waiting to go out, oldest first.
  const queue = useRef<Op[]>([])
  // True while a send is in flight, so the queue drains strictly in order.
  const sending = useRef(false)
  // A tree that arrived while the user was busy, waiting for them to stop.
  const pending = useRef<Tree | null>(null)
  // Consecutive failed reconnects. Reset by a successful open.
  const failures = useRef(0)
  // State rather than a ref: this one drives rendering.
  const [live, setLive] = useState(true)

  const busyRef = useRef(busy)
  busyRef.current = busy
  const onAdoptRef = useRef(onAdopt)
  onAdoptRef.current = onAdopt

  // Drain the queue one op at a time. A failed send puts the op back at the
  // front and stops: the server is unreachable, and dropping the op would lose
  // an edit the user can see on screen. The next op to be queued retries it,
  // and until then the local tree and localStorage still hold the change.
  const drain = useCallback(async () => {
    if (sending.current || !synced.current) return
    sending.current = true
    try {
      while (queue.current.length > 0) {
        const op = queue.current[0]
        const ok = await sendOp(op)
        if (!ok) break
        queue.current.shift()
      }
    } finally {
      sending.current = false
    }
  }, [])

  const send = useCallback(
    (...ops: Op[]) => {
      if (ops.length === 0) return
      queue.current.push(...ops)
      void drain()
    },
    [drain],
  )

  // Adopting is not a local change, so it must not enqueue anything: the tree we
  // just took *is* the server's.
  const adopt = useCallback((next: Tree) => {
    synced.current = true
    onAdoptRef.current(next)
  }, [])

  useEffect(() => {
    // Fetching the token is async, so the stream opens a tick later than it used
    // to. `cancelled` covers the unmount-during-await case: without it a
    // StrictMode double-mount (or a fast navigation) leaves a socket that
    // nothing holds a reference to and nothing ever closes.
    let cancelled = false
    let ws: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    // How long to wait before the next reconnect, doubling per failure. Reset on
    // every successful open so a later drop starts fast again.
    let backoff = RECONNECT_MIN_MS

    const onMessage = (e: MessageEvent) => {
      const { tree: next, origin } = JSON.parse(e.data) as { tree: Tree; origin: string | null }
      if (origin === ORIGIN) {
        // The echo of our own write. The local tree already has it, but this is
        // also proof the server is listening — so if this is the first message,
        // it still opens the write path.
        if (!synced.current) {
          synced.current = true
          void drain()
        }
        return
      }
      // Until the first sync, adopt even mid-edit: this is the authoritative
      // baseline, and it has to land before any op is replayed on top of it.
      if (busyRef.current && synced.current) {
        pending.current = next
        return
      }
      adopt(next)
      // Ops made before this point were held back; now they have a real tree to
      // replay against.
      void drain()
    }

    // Reopen after a drop. The URL is rebuilt every time rather than reused:
    // it carries a Clerk session token that expires in about a minute, so a
    // reconnect with the original URL would authenticate with a stale token and
    // be refused — leaving the tab silently deaf, which is the bug this exists
    // to prevent.
    const reconnect = () => {
      if (cancelled || retry) return
      // Counted here rather than in the timer so a burst of onclose+onerror for
      // one dead socket still counts once — `retry` collapses them.
      failures.current += 1
      if (failures.current >= FAILURES_BEFORE_WARNING) setLive(false)
      retry = setTimeout(() => {
        retry = null
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
        connect()
      }, backoff)
    }

    const connect = () => {
      void eventsUrl().then(
        (url) => {
          if (cancelled) return
          const socket = new WebSocket(url)
          ws = socket
          socket.onmessage = onMessage
          // The origin tag goes over the socket rather than in the URL, so the
          // server can label broadcasts with the tab that caused them. Writes
          // stay on HTTP — a write accepted over this socket would bypass the
          // token check the fetch handler does.
          socket.onopen = () => {
            backoff = RECONNECT_MIN_MS
            failures.current = 0
            setLive(true)
            socket.send(JSON.stringify({ type: 'hello', origin: ORIGIN }))
          }
          // Both, because they aren't redundant: onerror fires without onclose
          // when the handshake itself fails (an expired token is a handshake
          // failure), and onclose fires alone on a clean server-side drop.
          // `retry` makes the double case a single reconnect.
          socket.onclose = reconnect
          socket.onerror = reconnect
        },
        // eventsUrl awaits a token, and that can fail offline or mid-rotation.
        // Without this the promise rejects unhandled and the tab never retries.
        () => reconnect(),
      )
    }

    connect()

    return () => {
      cancelled = true
      if (retry) clearTimeout(retry)
      // Detach first: close() fires onclose, which would otherwise schedule a
      // reconnect for a component that is going away.
      if (ws) {
        ws.onclose = null
        ws.onerror = null
        ws.close()
      }
    }
  }, [adopt, drain])

  // The user stopped editing or dragging — apply whatever arrived meanwhile.
  useEffect(() => {
    if (!busy && pending.current) {
      const next = pending.current
      pending.current = null
      adopt(next)
    }
  }, [busy, adopt])

  return { send, live }
}
