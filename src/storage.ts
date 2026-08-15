/**
 * Persistence: the whole tree lives in one localStorage key as JSON, and the
 * same JSON is what export/import hands around.
 *
 * The server owns the tree now (see api.ts); this is the offline cache and the
 * boot value, so the app draws something before the first SSE frame lands. It's
 * whatever this browser last saw, not the truth — the server's tree replaces it
 * on connect. There's no schema migration story yet, so loading is defensive: a
 * blob that isn't a valid tree is ignored rather than allowed to crash the app.
 */

import { OP_KINDS, type Op } from '@shared/ops'
import { invalidTree, type Tree } from '@shared/tree'

const KEY = 'ansa.tree.v1'
const QUEUE_KEY = 'ansa.queue.v1'

/**
 * Parse a JSON string into a Tree, or return null if it isn't one.
 *
 * The shape checks live in shared/tree.ts, so that an imported file the app
 * accepts is exactly one the server's PUT will also take. When these were two
 * implementations, "imports fine, then fails to save" was a reachable state.
 */
export function parseTree(json: string): Tree | null {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return null
  }
  return invalidTree(data) === null ? (data as Tree) : null
}

/** The stored tree, or null when there's nothing saved or it's unreadable. */
export function loadTree(): Tree | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    // Private-mode or disabled storage — just run without persistence.
    return null
  }
  return raw ? parseTree(raw) : null
}

/** Persist the tree. Swallows quota/availability errors — a failed save must
 * never break the interaction that triggered it. */
export function saveTree(tree: Tree): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(tree))
  } catch {
    // ignore
  }
}

/**
 * The unsent op queue, persisted so that quitting doesn't lose edits.
 *
 * Without this the queue is only a React ref: the tree survives in localStorage,
 * but the ops that would tell the server about it don't, so the server's tree
 * overwrites that work at the next adopt. On desktop you have to quit at the
 * wrong moment; on a phone the OS kills backgrounded apps as a matter of course.
 *
 * Validation is deliberately shallow — an object with a known `op` name. It does
 * not check each variant's fields, because it doesn't have to: the server
 * validates every op it receives, and a rejected one is discarded with a toast
 * rather than retried. The only job here is to keep a corrupt blob from crashing
 * the boot, so anything that survives is merely plausible, not trusted.
 */
export function loadQueue(): Op[] {
  let raw: string | null
  try {
    raw = localStorage.getItem(QUEUE_KEY)
  } catch {
    return []
  }
  if (!raw) return []
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  const kinds: readonly string[] = OP_KINDS
  return data.filter(
    (item): item is Op =>
      typeof item === 'object' &&
      item !== null &&
      kinds.includes((item as { op?: unknown }).op as string),
  )
}

/** Persist the unsent queue. Swallows errors, like saveTree. */
export function saveQueue(queue: Op[]): void {
  try {
    if (queue.length === 0) localStorage.removeItem(QUEUE_KEY)
    else localStorage.setItem(QUEUE_KEY, JSON.stringify(queue))
  } catch {
    // ignore
  }
}

/** Pretty JSON for the download file. */
export function exportTree(tree: Tree): string {
  return JSON.stringify(tree, null, 2)
}
