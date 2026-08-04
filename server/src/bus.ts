/**
 * A tiny in-process event bus for Server-Sent Events.
 *
 * Every open `GET /api/events` connection registers here against the owner
 * whose tree it wants. After any write, the route calls `broadcast(owner, tree,
 * origin)` and each of *that owner's* subscribers gets the new tree pushed down
 * its stream — so a change from anyone (a human on a phone, a Claude on the MCP)
 * reaches every open browser without polling.
 *
 * The owner key is not an optimisation. This bus sends whole trees, so a
 * broadcast that ignored ownership would hand every connected client everyone
 * else's data on every write — a leak that no amount of correct filtering on the
 * request path would undo.
 *
 * `origin` is the id of the client that caused the change. It rides along so a
 * client can ignore the echo of its *own* write (it already holds that state),
 * which is what keeps a local edit from being clobbered by its own broadcast.
 *
 * In-process is deliberate: one server, one bus. Scaling to multiple server
 * instances later means swapping this for a shared pub/sub (Redis/NATS) — the
 * call sites don't change.
 */

import type { ServerResponse } from 'node:http'
import type { Tree } from '../../shared/tree.ts'
import type { OwnerId } from './store.ts'

const clients = new Map<OwnerId, Set<ServerResponse>>()

/** Register a raw response as a subscriber to one owner's tree; returns an unsubscribe fn. */
export function subscribe(owner: OwnerId, res: ServerResponse): () => void {
  const set = clients.get(owner) ?? new Set<ServerResponse>()
  set.add(res)
  clients.set(owner, set)
  return () => {
    const current = clients.get(owner)
    if (!current) return
    current.delete(res)
    // Drop the empty set rather than accumulating one per user who ever connected.
    if (current.size === 0) clients.delete(owner)
  }
}

/** Push the new tree to that owner's subscribers, tagged with who caused the change. */
export function broadcast(owner: OwnerId, tree: Tree, origin: string | null): void {
  const set = clients.get(owner)
  if (!set) return
  const payload = `data: ${JSON.stringify({ tree, origin })}\n\n`
  for (const res of set) {
    // A dead socket throws on write; drop it rather than let it wedge the loop.
    try {
      res.write(payload)
    } catch {
      set.delete(res)
    }
  }
  if (set.size === 0) clients.delete(owner)
}
