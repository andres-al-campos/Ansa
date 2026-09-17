/**
 * What the server pushes down the WebSocket.
 *
 * An ordinary edit travels as the one op that was applied, so a write costs
 * every listener a hundred bytes rather than the whole tree. Writes that have
 * no op form — a whole-tree import, a restore from the trash, the MCP's direct
 * routes — send the tree, as every write once did. The first frame on a new
 * socket is always a tree, so a client never has to apply an op to a tree it
 * has not seen.
 *
 * Every frame carries the fingerprint of the server's tree after the write.
 * That is what makes sending ops safe: a client that ends up holding something
 * else finds out on the next quiet moment and refetches. See `fingerprint`.
 */

import type { Op } from './ops.ts'
import type { Tree } from './tree.ts'

export type Frame =
  | {
      kind: 'tree'
      tree: Tree
      /** The `x-ansa-origin` of the client whose write this was, or null. */
      origin: string | null
      hash: string
    }
  | {
      kind: 'op'
      op: Op
      origin: string | null
      hash: string
    }

/**
 * Read a frame off the wire, tolerating the shape from before frames had a
 * kind. A server still sending `{ tree, origin }` is treated as a tree frame
 * with no fingerprint, so a client updated ahead of the server keeps working
 * and simply skips the check it cannot make.
 */
export function parseFrame(raw: unknown): Frame | null {
  if (typeof raw !== 'object' || raw === null) return null
  const v = raw as Record<string, unknown>
  const origin = typeof v.origin === 'string' ? v.origin : null
  const hash = typeof v.hash === 'string' ? v.hash : ''
  if (v.kind === 'op' && typeof v.op === 'object' && v.op !== null) {
    return { kind: 'op', op: v.op as Op, origin, hash }
  }
  if ((v.kind === 'tree' || v.kind === undefined) && Array.isArray(v.tree)) {
    return { kind: 'tree', tree: v.tree as Tree, origin, hash }
  }
  return null
}
