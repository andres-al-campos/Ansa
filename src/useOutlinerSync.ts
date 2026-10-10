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
 *  - **Death.** The queue is persisted, so it can outlive the process — a tab
 *    closed while offline, or a phone app the OS killed, still delivers its
 *    edits on the next run. This falls out of the rule above rather than needing
 *    its own: a restored op is held until the first adopt and then replayed onto
 *    the server's tree, which is the same treatment an op made while
 *    disconnected already got.
 *
 *  - **Interruption.** An incoming change must not be applied while the user is
 *    mid-edit or mid-drag, so frames are held in order and applied the moment
 *    they're idle.
 *
 *  - **Drift.** The server sends an op, not the tree, so this tab is trusted to
 *    apply it and end up where the server is. Every frame carries the
 *    fingerprint of the server's tree, and the next quiet moment — nothing
 *    queued, nothing in flight, nothing held — compares it to ours. A mismatch
 *    means something went wrong (a refused op still on screen, an op applied
 *    against a tree it was not made for) and the tree is refetched.
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
import { parseFrame, type Frame } from '@shared/frame'
import { applyOp, type Op } from '@shared/ops'
import { fingerprint, type Tree } from '@shared/tree'
import { eventsUrl, fetchTree, ORIGIN, sendOp } from './api'
import { loadQueue, saveQueue } from './storage'

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

// How often a queue stalled by an unreachable server retries on its own. Slow
// enough to be nothing on an idle tab, fast enough that a blip costs seconds
// rather than lasting until the user happens to type again.
const WRITE_RETRY_MS = 5_000

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
  /**
   * How many edits the server refused this session.
   *
   * Separate from `live` because it is a different failure with a different
   * consequence: `live` means this tab stopped *receiving* and nothing of the
   * user's is at risk, while this means an edit they made was not stored and is
   * about to disappear from the screen when the server's tree is adopted.
   */
  rejected: number
  /**
   * The server's explanation for the latest refusal, when it is one a person
   * can act on. Null when the reason is internal and the generic wording is
   * the honest thing to show.
   */
  rejectedReason: string | null
  /** Forget the rejection count, so the warning can be dismissed. */
  clearRejected: () => void
}

/**
 * Whether a refusal reason is worth putting in front of the user.
 *
 * Most are not: "unknown node: abc123" names an id nobody has seen and
 * describes a race the user cannot act on. The limits are the exception —
 * being at the node cap is a real state of their outline with a real remedy,
 * and only the server knows they hit it.
 *
 * Matched on the text rather than a code because the server sends prose today.
 * If more of these appear, the refusal should carry a kind and this should read
 * that instead.
 */
function isForAPerson(reason: string): boolean {
  return reason.includes('which is the limit')
}

/**
 * A server tree with this tab's unsent ops put back on top.
 *
 * The server's tree does not hold what is still queued here, so adopting it
 * bare takes those edits off the screen while they are still on their way out.
 * An add whose node the tree already has is skipped: that op reached the server
 * and only its acknowledgement was lost.
 */
export function withUnsent(tree: Tree, ops: Op[]): Tree {
  return ops.reduce((t, op) => {
    const ids = op.op === 'addChild' ? [op.id] : op.op === 'addSubtree' ? op.ids : []
    if (ids.some((id) => t.some((n) => n.id === id))) return t
    return applyOp(t, op).tree
  }, tree)
}

export function useOutlinerSync({
  busy,
  tree,
  onAdopt,
  onApply,
}: {
  /** True while the user is editing or dragging — don't yank the tree away. */
  busy: boolean
  /** The tree as this tab currently holds it, for the fingerprint check. */
  tree: Tree
  /**
   * Called with a tree that should replace local state: the server's, with
   * this tab's queued ops already replayed on it.
   */
  onAdopt: (tree: Tree) => void
  /**
   * Called with an op made elsewhere that should be applied to local state.
   * Not a local edit: it must not be queued, and it should not be an undo step.
   */
  onApply: (op: Op) => void
}): OutlinerSync {
  // Whether the server's authoritative tree has been adopted at least once.
  // Until it has, queued ops stay put — see the stale-cache note above.
  const synced = useRef(false)
  // Ops waiting to go out, oldest first. Restored from localStorage so that ops
  // written by a previous run — one the OS killed, or a quit while offline —
  // still reach the server. Every mutation goes through persistQueue.
  const queue = useRef<Op[]>(loadQueue())
  // True while a send is in flight, so the queue drains strictly in order.
  const sending = useRef(false)
  // Frames that arrived while the user was busy, oldest first, waiting for
  // them to stop. Ops have to be applied in the order the server applied them,
  // so this is a list and not a slot. A tree frame makes everything before it
  // moot, so it empties the list when it lands.
  const pending = useRef<Frame[]>([])
  // The fingerprint on the last frame seen, from any origin — our own echo
  // counts, since after it the server's tree should be ours. Empty until a
  // frame carrying one arrives; a server from before fingerprints sends none.
  const lastHash = useRef('')
  // Set by every frame, cleared by the check it triggers. Checking once per
  // frame rather than on every local change keeps a local-only divergence — an
  // undo, which sends no op — where it has always been: on screen until the
  // next remote change, not refetched away the moment it happens.
  const unverified = useRef(false)
  // Own ops the server has accepted whose echo has not come back yet. The
  // echo and the HTTP response travel on different connections, so either can
  // arrive first: a check run between the response and the echo would compare
  // a tree holding the op against a fingerprint from before it. Nothing is
  // checked until this is zero. Reset when a socket opens, because echoes for
  // ops sent while the old one was down went nowhere, and the new socket's
  // first frame is a whole tree anyway.
  const awaitingEcho = useRef(0)
  // True while a refetch is in flight, so a burst of frames does not start
  // several.
  const refetching = useRef(false)
  // Consecutive failed reconnects. Reset by a successful open.
  const failures = useRef(0)
  // State rather than a ref: these drive rendering.
  const [live, setLive] = useState(true)
  // How many edits the server has refused this session. A count rather than a
  // flag so the toast can say whether this happened once or is happening
  // repeatedly — the second means something is actually wrong.
  const [rejected, setRejected] = useState(0)
  // The server's own words for the most recent refusal, when they are meant for
  // a person. The node cap is the case this exists for: "you are at the limit,
  // delete something" is advice the toast cannot reconstruct from a count, and
  // guessing "an edit to something removed on another device" would be wrong
  // and unactionable. Null when the reason is internal, which the toast reads
  // as "use the generic wording".
  const [rejectedReason, setRejectedReason] = useState<string | null>(null)
  // Bumped whenever a frame is taken. The fingerprint check reads the tree
  // through a ref, and right after a take that ref still holds the tree from
  // before the op — the state update has not rendered yet. So the check runs
  // from an effect, and this is what makes that effect run even when the
  // frame left the tree looking the same.
  const [taken, setTaken] = useState(0)

  const busyRef = useRef(busy)
  busyRef.current = busy
  const treeRef = useRef(tree)
  treeRef.current = tree
  const onAdoptRef = useRef(onAdopt)
  onAdoptRef.current = onAdopt
  const onApplyRef = useRef(onApply)
  onApplyRef.current = onApply

  // Adopting is not a local change, so it must not enqueue anything. What is
  // already queued goes back on top: the first tree lands even mid-edit, and a
  // person who started typing before it arrived would otherwise watch their
  // rows vanish while the ops that made them were still waiting to be sent.
  const adopt = useCallback((next: Tree) => {
    synced.current = true
    onAdoptRef.current(withUnsent(next, queue.current))
  }, [])

  // Take one frame now. Callers have already decided the user is not busy.
  const take = useCallback(
    (frame: Frame) => {
      if (frame.kind === 'tree') adopt(frame.tree)
      else onApplyRef.current(frame.op)
      setTaken((n) => n + 1)
    },
    [adopt],
  )

  // Replace the local tree with the server's, through the busy gate like any
  // other frame. The fingerprint of what comes back is the new baseline: the
  // server may have moved on again by the time it arrives, and if so the next
  // frame says so.
  const refetch = useCallback(async () => {
    if (refetching.current) return
    refetching.current = true
    try {
      const next = await fetchTree()
      if (!next) return
      lastHash.current = fingerprint(next)
      unverified.current = false
      const frame: Frame = { kind: 'tree', tree: next, origin: null, hash: lastHash.current }
      if (busyRef.current) {
        pending.current = [frame]
      } else {
        take(frame)
      }
    } finally {
      refetching.current = false
    }
  }, [take])

  // The check. Only meaningful when quiet: with an op queued or in flight the
  // local tree is legitimately ahead of the server, and with frames held the
  // server is legitimately ahead of us. Neither is drift.
  const verify = useCallback(() => {
    if (!unverified.current || !lastHash.current) return
    if (busyRef.current || sending.current || queue.current.length > 0) return
    if (pending.current.length > 0 || awaitingEcho.current > 0) return
    unverified.current = false
    if (fingerprint(treeRef.current) === lastHash.current) return
    console.warn('Ansa: this tab had drifted from the server; refetching the tree.')
    void refetch()
  }, [refetch])

  // Drain the queue one op at a time.
  //
  // The two failures are handled oppositely, and conflating them is what used to
  // wedge this queue permanently:
  //
  //  - **Unreachable.** Nothing is known about the op, so it stays at the head
  //    and the whole queue waits. Dropping it would lose an edit the user can
  //    see on screen. A timer retries it — waiting for the next keystroke means
  //    a tab that stops being typed in never sends what it already has.
  //
  //  - **Rejected.** The server has judged this op and will judge it the same
  //    way every time, so it is discarded rather than retried. Keeping it would
  //    block every later edit forever while the tab looked healthy. The usual
  //    cause is a lost race — the op's parent was deleted on another device —
  //    and refetching the server's tree is what puts this tab back in step.
  // Mirror the queue to localStorage after every change. Called on each shift
  // rather than once at the end of the drain, because the tab can die mid-drain
  // and the stored copy has to match what has actually gone out.
  const persistQueue = useCallback(() => {
    saveQueue(queue.current)
  }, [])

  const drain = useCallback(async () => {
    if (sending.current || !synced.current || queue.current.length === 0) return
    sending.current = true
    try {
      while (queue.current.length > 0) {
        const op = queue.current[0]
        const result = await sendOp(op)
        if (result.status === 'unreachable') break
        queue.current.shift()
        persistQueue()
        if (result.status === 'ok') awaitingEcho.current += 1
        if (result.status === 'rejected') {
          // Loud in the console because a malformed op is a client bug and
          // should be debuggable; plain in the UI because the common cause is
          // an ordinary race the user can do nothing about.
          console.error('Ansa: the server refused an edit —', result.reason, op)
          setRejected((n) => n + 1)
          setRejectedReason(isForAPerson(result.reason) ? result.reason : null)
          // The edit is still on screen and never will be on the server. The
          // server's tree is the only thing that puts this tab straight, and
          // nothing else is going to send it: the refusal produced no frame.
          void refetch()
        }
      }
    } finally {
      sending.current = false
    }
    // The queue just emptied (or stalled). If a frame arrived mid-drain, this
    // is the first quiet moment since. Safe to check here and not only from
    // the effect: at least one send was awaited above, so any frame taken
    // before it has rendered by now.
    verify()
  }, [persistQueue, refetch, verify])

  const send = useCallback(
    (...ops: Op[]) => {
      if (ops.length === 0) return
      queue.current.push(...ops)
      persistQueue()
      void drain()
    },
    [drain, persistQueue],
  )

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
      const frame = parseFrame(JSON.parse(e.data))
      if (!frame) return
      if (frame.hash) {
        lastHash.current = frame.hash
        unverified.current = true
      }
      if (frame.origin === ORIGIN) {
        // The echo of our own write. The local tree already has it, but this is
        // also proof the server is listening — so if this is the first message,
        // it still opens the write path.
        if (awaitingEcho.current > 0) awaitingEcho.current -= 1
        if (!synced.current) {
          synced.current = true
          void drain()
        }
        verify()
        return
      }
      if (frame.kind === 'op') {
        // An op is only meaningful against the tree it was applied to. Before
        // the first tree has landed we do not have that, and the tree that is
        // coming will already include this op.
        if (!synced.current) return
        if (busyRef.current) {
          pending.current.push(frame)
          return
        }
        take(frame)
        return
      }
      // Until the first sync, adopt even mid-edit: this is the authoritative
      // baseline, and it has to land before any op is replayed on top of it.
      if (busyRef.current && synced.current) {
        pending.current = [frame]
        return
      }
      take(frame)
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
          // Nothing is ever sent on this socket — it's receive-only. Ops go over
          // HTTP, and each op carries this tab's origin, which is what the
          // server stamps its broadcasts with.
          socket.onopen = () => {
            backoff = RECONNECT_MIN_MS
            failures.current = 0
            awaitingEcho.current = 0
            setLive(true)
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
  }, [drain, take, verify])

  // Retry a queue held up by an unreachable server.
  //
  // Without this the only thing that retries is the next call to send(), so a
  // tab that stops being edited keeps whatever it hadn't managed to save —
  // indefinitely, and silently. That is the same shape of bug as the deaf
  // socket: the tab looks fine because the local tree and localStorage still
  // hold the change.
  //
  // A plain interval rather than a backoff: drain() exits immediately when the
  // queue is empty or a send is already in flight, so an idle tab does nothing
  // but check a length.
  useEffect(() => {
    const id = setInterval(() => {
      if (queue.current.length > 0) void drain()
    }, WRITE_RETRY_MS)
    return () => clearInterval(id)
  }, [drain])

  // The user stopped editing or dragging — apply whatever arrived meanwhile, in
  // the order it arrived.
  useEffect(() => {
    if (busy) return
    while (pending.current.length > 0) {
      const frame = pending.current.shift()!
      take(frame)
    }
  }, [busy, take])

  // A frame was taken, the tree changed, or the user went quiet: settle any
  // frame not yet checked. An effect rather than a call at the take, because
  // it has to run after the render that applied the frame.
  useEffect(() => {
    verify()
  }, [tree, busy, taken, verify])

  const clearRejected = useCallback(() => {
    setRejected(0)
    setRejectedReason(null)
  }, [])

  return { send, live, rejected, rejectedReason, clearRejected }
}
