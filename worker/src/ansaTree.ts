/**
 * One owner's tree, as a Durable Object: their SQLite database and their open
 * connections, in one place.
 *
 * This replaces server/src/bus.ts, whose own comment predicted this change —
 * "scaling to multiple server instances later means swapping this for a shared
 * pub/sub; the call sites don't change". The Map<OwnerId, Set<ServerResponse>>
 * is gone: Cloudflare routes every request for an owner to that owner's single
 * object, so the set of connections to broadcast to is just this object's own
 * sockets. Broadcasting to the wrong owner is not a bug that can be written
 * here, because another owner's sockets are attached to a different object.
 *
 * ## Why WebSockets rather than the SSE the Node server used
 *
 * Not preference — the free plan. An SSE response holds the object in memory
 * for as long as it is open, and duration is billed: 13,000 GB-s/day free is
 * about 29 object-hours at 128 MB, so a couple of tabs left open all day would
 * exhaust the daily allowance and every further request would fail until 00:00
 * UTC. Hibernatable WebSockets accrue no duration while idle, so an open tab
 * that nobody is typing in costs nothing.
 *
 * Hibernation is why the socket handlers are methods on this class rather than
 * closures over local state: between two messages the object may be evicted
 * from memory entirely and reconstructed, so anything held in a field would be
 * gone. ctx.getWebSockets() survives that; a Set in a field would not.
 */

import { DurableObject } from 'cloudflare:workers'
import { RejectedWriteError, TreeStore, type TrashEntry } from './treeStore.ts'
import type { Frame } from '../../shared/frame.ts'
import { parseOp, parseSpecs, type Op } from '../../shared/ops.ts'
import { fingerprint, invalidTree, type Tree } from '../../shared/tree.ts'
import { tutorialTree } from '../../shared/tutorial.ts'

/** How long a deleted subtree is kept before the sweep drops it. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** How often the sweep runs. */
const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000

export class AnsaTree extends DurableObject {
  private store: TreeStore

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx as never, env as never)
    this.store = new TreeStore(ctx.storage.sql)
  }

  // ---------------------------------------------------------------- reads

  load(): Tree {
    return this.store.load()
  }

  /**
   * Seed the tutorial, but only into an account that has nothing.
   *
   * The guard is the point. A read that seeds is how 26 rows appeared under
   * accounts that had never typed anything, and on a hosted instance there is
   * no local file to carve the real rows back out of. It also makes an
   * interrupted import safe to retry.
   */
  seedIfEmpty(): { seeded: boolean; tree: Tree } {
    const existing = this.store.load()
    if (existing.length > 0) return { seeded: false, tree: existing }
    const tree = this.store.replaceAll(tutorialTree())
    this.broadcast(tree, null)
    return { seeded: true, tree }
  }

  // --------------------------------------------------------------- writes

  /**
   * Apply a client op and push the result to every open socket.
   *
   * Wrapped in transactionSync so a throw from the pure op or the validity
   * check leaves the table untouched — the load/replace pair is two statements
   * and a failure between them would persist half a write.
   */
  async applyOp(rawOp: unknown, origin: string | null): Promise<{ tree: Tree; completed: string[] }> {
    const parsed = parseOp(rawOp)
    if ('error' in parsed) throw new RejectedWriteError(parsed.error)
    const result = this.ctx.storage.transactionSync(() => this.store.applyOp(parsed.op))
    this.broadcast(result.tree, origin, parsed.op)
    if (parsed.op.op === 'removeNode' && parsed.op.trash) await this.ensureSweepScheduled()
    return result
  }

  addSubtree(parentId: string | null, rawSpecs: unknown, origin: string | null): { tree: Tree; ids: string[] } {
    // parseSpecs returns the specs or the first problem as a string, so the
    // shape check and the walk happen once, here, and no second write path
    // can drift into accepting a different shape.
    const parsed = parseSpecs(rawSpecs, 'nodes')
    if (typeof parsed === 'string') throw new RejectedWriteError(parsed)
    const result = this.ctx.storage.transactionSync(() => this.store.addSubtree(parentId, parsed))
    this.broadcast(result.tree, origin)
    return result
  }

  /**
   * The fine-grained mutations, kept for the MCP server.
   *
   * The app itself writes through applyOp — one named op, applied to whatever
   * the tree is now. These stay because the MCP tools call them directly, and
   * because collapsing them into ops would change that interface for no gain.
   *
   * Each is the same three steps: mutate inside a transaction, broadcast,
   * return. The repetition is deliberate — a generic dispatcher here would
   * take a method name from the caller, and "which method" is exactly the kind
   * of thing that should not be data.
   */
  addChild(parentId: string | null, text: string, origin: string | null): { tree: Tree; id: string } {
    const result = this.ctx.storage.transactionSync(() => this.store.addChild(parentId, text))
    this.broadcast(result.tree, origin)
    return result
  }

  rename(id: string, text: string, origin: string | null): Tree {
    return this.write(() => this.store.rename(id, text), origin)
  }

  setDone(id: string, done: boolean, origin: string | null): { tree: Tree; completed: string[] } {
    const result = this.ctx.storage.transactionSync(() => this.store.setDone(id, done))
    this.broadcast(result.tree, origin)
    return result
  }

  setPinned(id: string, pinned: boolean, origin: string | null): Tree {
    return this.write(() => this.store.setPinned(id, pinned), origin)
  }

  async remove(id: string, origin: string | null, trash = false): Promise<Tree> {
    const next = this.write(() => this.store.remove(id, trash), origin)
    // Armed here rather than in the constructor or on every write: something
    // was just put in the trash, so a sweep now has work to do eventually.
    // Nothing else needs one, and an empty trash should cost no wake-ups.
    if (trash) await this.ensureSweepScheduled()
    return next
  }

  move(id: string, parentId: string | null, index: number, origin: string | null): Tree {
    return this.write(() => this.store.move(id, parentId, index), origin)
  }

  toggleCollapsed(id: string, origin: string | null): Tree {
    return this.write(() => this.store.toggleCollapsed(id), origin)
  }

  markOpened(id: string, origin: string | null): Tree {
    return this.write(() => this.store.markOpened(id), origin)
  }

  /** Run a tree-returning mutation in a transaction and broadcast the result. */
  private write(mutate: () => Tree, origin: string | null): Tree {
    const tree = this.ctx.storage.transactionSync(mutate)
    this.broadcast(tree, origin)
    return tree
  }

  // ------------------------------------------------------------- the trash

  /**
   * A page of deleted subtrees, newest first.
   *
   * Its own call rather than something riding along with the tree: the trash is
   * looked at rarely and can grow large, and `load()` already reads the whole
   * tree on every edit. Keeping it out of that path is the point of storing it
   * separately at all.
   */
  trashPage(limit?: number, cursor?: number): { entries: TrashEntry[]; nextCursor?: number } {
    return this.store.trashPage(limit, cursor)
  }

  /**
   * Put a trashed subtree back. Returns null if the entry is already gone.
   *
   * Broadcasts like any other write, so a restore on one device appears on the
   * others by the path every edit already uses.
   */
  restore(entryId: string, origin: string | null): Tree | null {
    const tree = this.ctx.storage.transactionSync(() => this.store.restore(entryId))
    if (tree) this.broadcast(tree, origin)
    return tree
  }

  /**
   * Drop one trashed subtree for good.
   *
   * Broadcasts even though the tree does not change. Forgetting only touches
   * `trash_nodes` — the node left `nodes` when it was deleted — so there was no
   * new tree to send and this was the one trash mutation that sent nothing.
   * Deleting synced and permanently deleting did not.
   *
   * The tree is what the socket carries, so an unchanged one is what there is
   * to send: it costs a redundant payload on an action taken rarely, and it
   * wakes the other device's sync so a trash opened after this sees the row
   * gone. A device with the trash already open still shows the stale row —
   * that needs a message type of its own, which is a protocol change for a
   * case that has not come up yet.
   */
  forget(entryId: string, origin: string | null = null): void {
    const tree = this.ctx.storage.transactionSync(() => {
      this.store.forget(entryId)
      return this.store.load()
    })
    this.broadcast(tree, origin)
  }

  /**
   * Daily retention sweep.
   *
   * The trash is never something to remember to empty — there is no button for
   * it and no badge asking to be cleared, because a tool that generates chores
   * is the thing this app exists to avoid. This is what makes that true.
   *
   * Sweeping on read was the alternative and fails the same test: a trash
   * nobody opens would never empty, and this one is expected to fill with small
   * throwaway tasks precisely because deleting is meant to be cheap.
   *
   * Stops re-arming once the trash is empty, and the next delete arms it again.
   * An object nobody deletes from should not wake daily forever.
   */
  async alarm(): Promise<void> {
    // The platform clears the alarm before invoking this, so not re-arming
    // below is what stops the wake-ups — there is nothing to delete.
    const remaining = this.ctx.storage.transactionSync(() => {
      this.store.sweep(Date.now() - RETENTION_MS)
      return this.store.trashCount()
    })
    if (remaining > 0) await this.ctx.storage.setAlarm(Date.now() + SWEEP_EVERY_MS)
  }

  /**
   * Make sure the sweep is scheduled, without resetting a pending one.
   *
   * Checked rather than set unconditionally: the delete path runs often, and
   * `setAlarm` replaces any pending alarm, so setting it on every delete would
   * push the sweep 24h further out each time — a trash that never expires
   * because it keeps being added to.
   *
   * Awaited by the delete path rather than left to run detached. A
   * fire-and-forget promise here would usually work and occasionally not: the
   * object can be evicted once the response is sent, and a delete whose alarm
   * never landed leaves a trash entry that is never swept — a leak that shows up
   * as storage nobody can account for, months later, with nothing to trace it
   * back to. It costs one storage read on deletes only, which is why `remove`
   * and `applyOp` are async.
   */
  private async ensureSweepScheduled(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_EVERY_MS)
    }
  }

  /** Whole-tree replace. Used by Import and by the migration script. */
  replaceAll(tree: unknown, origin: string | null): Tree {
    const bad = invalidTree(tree)
    if (bad) throw new RejectedWriteError(`That tree is not valid (${bad}); nothing was saved.`)
    const next = this.ctx.storage.transactionSync(() => this.store.replaceAll(tree as Tree))
    this.broadcast(next, origin)
    return next
  }

  // ---------------------------------------------------------- connections

  /**
   * Upgrade a request to a hibernatable WebSocket carrying this owner's tree.
   *
   * ctx.acceptWebSocket rather than server.accept(): the latter keeps the
   * object resident and billing for the life of the connection, which is the
   * whole problem this design avoids.
   *
   * Reached through fetch() rather than as an RPC method, and that is not
   * stylistic. A Response carrying a `webSocket` cannot cross the RPC boundary
   * — returning one from a method fails with DataCloneError, "Could not
   * serialize object of type WebSocket". fetch() is the one path that hands a
   * live socket back to the worker.
   */
  override fetch(req: Request): Response {
    if (req.headers.get('upgrade') !== 'websocket') {
      return new Response('This endpoint expects a WebSocket upgrade.', { status: 426 })
    }
    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server)
    // The current tree immediately, so a client that just connected doesn't
    // render empty while it waits for someone else to make a change.
    const tree = this.store.load()
    const frame: Frame = { kind: 'tree', tree, origin: null, hash: fingerprint(tree) }
    server.send(JSON.stringify(frame))
    return new Response(null, { status: 101, webSocket: client })
  }

  // No webSocketMessage handler: the socket is receive-only. Writes go over
  // HTTP, deliberately — they need Clerk verification, and a socket message
  // would bypass the auth the fetch handler does. There was once a hello frame
  // carrying the client's origin tag, but the server never needed it: broadcast
  // stamps one payload with the *writer's* origin and sends that same string to
  // everyone, and each client compares it against its own. Per-socket state
  // would only matter if a broadcast differed per recipient.

  /**
   * A client went away.
   *
   * Nothing to tear down: the socket set is ctx.getWebSockets(), which the
   * runtime maintains, so a closed connection leaves it without help. The
   * close() call is belt-and-braces — from compatibility date 2026-04-07 the
   * runtime auto-replies to Close frames, and this worker is pinned past that,
   * so it is safe but not required.
   *
   * 1005 means "no status received" and is not a code close() accepts, so it
   * has to be mapped rather than echoed back.
   */
  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    ws.close(code === 1005 ? 1000 : code, reason)
  }

  /**
   * A socket failed rather than closing cleanly.
   *
   * Without this handler an errored connection is left for the runtime to
   * reap on its own schedule, and until it does, broadcast() keeps trying to
   * send to it. Sends to a dead socket are already caught one by one, so the
   * cost is wasted work rather than a dropped broadcast — but closing it here
   * ends that immediately.
   */
  webSocketError(ws: WebSocket): void {
    try {
      ws.close(1011, 'socket error')
    } catch {
      // Already gone. Nothing to do, and throwing from this handler would
      // take the object down with it.
    }
  }

  /**
   * Push a tree to every open socket, tagged with the client that caused it.
   *
   * That tag is what lets a client ignore the echo of its own write — it
   * already holds that state, and re-adopting it is what used to clobber a
   * local edit mid-keystroke.
   */
  /**
   * Push a write to every open socket.
   *
   * With `op`, the frame carries that op and not the tree: the receivers apply
   * it themselves, which costs them a hundred bytes rather than the whole tree
   * on every keystroke. Without one — a restore, an import, an MCP route with no
   * op form — the tree goes as it always did. Either way the frame is stamped
   * with the fingerprint of `tree`, so a receiver can tell whether it ended up
   * holding the same thing. See shared/frame.ts.
   */
  private broadcast(tree: Tree, origin: string | null, op?: Op): void {
    const hash = fingerprint(tree)
    const frame: Frame = op ? { kind: 'op', op, origin, hash } : { kind: 'tree', tree, origin, hash }
    const payload = JSON.stringify(frame)
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload)
      } catch {
        // A socket that's gone but not yet cleaned up throws; skipping it beats
        // letting one dead connection stop the rest of the broadcast.
      }
    }
  }
}
