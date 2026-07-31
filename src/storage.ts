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

import { invalidTree, type Tree } from '@shared/tree'

const KEY = 'ansa.tree.v1'

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

/** Pretty JSON for the download file. */
export function exportTree(tree: Tree): string {
  return JSON.stringify(tree, null, 2)
}
