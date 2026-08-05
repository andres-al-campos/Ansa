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
 */

import { useCallback, useEffect, useRef } from 'react'
import type { Op } from '@shared/ops'
import type { Tree } from '@shared/tree'
import { eventsUrl, ORIGIN, sendOp } from './api'

export interface OutlinerSync {
  /** Queue ops to send, in order. Applied locally by the caller already. */
  send: (...ops: Op[]) => void
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
    // StrictMode double-mount (or a fast navigation) leaves an EventSource that
    // nothing holds a reference to and nothing ever closes.
    let cancelled = false
    let es: EventSource | null = null

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

    void eventsUrl().then((url) => {
      if (cancelled) return
      es = new EventSource(url)
      es.onmessage = onMessage
    })

    return () => {
      cancelled = true
      es?.close()
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

  return { send }
}
