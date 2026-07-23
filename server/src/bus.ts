/**
 * A tiny in-process event bus for Server-Sent Events.
 *
 * Every open `GET /api/events` connection registers here. After any write, the
 * route calls `broadcast(tree, origin)` and each subscriber gets the new tree
 * pushed down its stream — so a change from anyone (a human, or a Claude on the
 * MCP) reaches every open browser without polling.
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

const clients = new Set<ServerResponse>()

/** Register a raw response as an SSE subscriber; returns an unsubscribe fn. */
export function subscribe(res: ServerResponse): () => void {
  clients.add(res)
  return () => clients.delete(res)
}

/** Push the new tree to every subscriber, tagged with who caused the change. */
export function broadcast(tree: Tree, origin: string | null): void {
  const payload = `data: ${JSON.stringify({ tree, origin })}\n\n`
  for (const res of clients) {
    // A dead socket throws on write; drop it rather than let it wedge the loop.
    try {
      res.write(payload)
    } catch {
      clients.delete(res)
    }
  }
}
