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

import type { Node, Tree } from '@shared/tree'

const KEY = 'ansa.tree.v1'

/** True when `value` is shaped like a Node. Unknown extra keys are tolerated. */
function isNode(value: unknown): value is Node {
  if (typeof value !== 'object' || value === null) return false
  const n = value as Record<string, unknown>
  return (
    typeof n.id === 'string' &&
    (n.parentId === null || typeof n.parentId === 'string') &&
    typeof n.text === 'string' &&
    typeof n.done === 'boolean' &&
    typeof n.order === 'number' &&
    typeof n.collapsed === 'boolean' &&
    typeof n.createdAt === 'number'
  )
}

/**
 * Parse a JSON string into a Tree, or return null if it isn't one.
 *
 * Beyond per-node shape it checks referential sanity: ids are unique and every
 * parentId points at a node that exists. A dangling parentId would orphan a
 * whole branch out of every view, so we'd rather reject the blob and fall back
 * to the seed than silently lose tasks.
 */
export function parseTree(json: string): Tree | null {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return null
  }
  if (!Array.isArray(data) || !data.every(isNode)) return null

  const tree = data as Tree
  const ids = new Set(tree.map((n) => n.id))
  if (ids.size !== tree.length) return null
  for (const n of tree) {
    if (n.parentId !== null && !ids.has(n.parentId)) return null
  }
  return tree
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

/** Pretty JSON for the download file. */
export function exportTree(tree: Tree): string {
  return JSON.stringify(tree, null, 2)
}
