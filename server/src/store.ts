/**
 * The store: SQLite is the source of truth, the pure tree operations in
 * shared/tree.ts are the only way the tree changes.
 *
 * Every mutation follows the same shape — load the whole tree, apply a pure
 * op, persist the result — so the server never reimplements tree logic that
 * the app already trusts. The table *is* the flat Node array, one row per node,
 * which is exactly why the flat model was chosen in the first place.
 *
 * A single-user local tool doesn't need row-level updates or clever diffing:
 * the whole tree is a few KB, and rewriting it inside one transaction keeps the
 * DB and the in-memory tree impossible to desync.
 */

import Database from 'better-sqlite3'
import {
  addChild,
  moveNode,
  removeNode,
  setDone,
  setPinned,
  setText,
  toggleCollapsed,
  type NodeId,
  type Tree,
} from '../../shared/tree.ts'

export class Store {
  private db: Database.Database

  constructor(filename: string) {
    this.db = new Database(filename)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id        TEXT PRIMARY KEY,
        parentId  TEXT REFERENCES nodes(id) ON DELETE CASCADE,
        text      TEXT NOT NULL,
        done      INTEGER NOT NULL DEFAULT 0,
        "order"   INTEGER NOT NULL DEFAULT 0,
        collapsed INTEGER NOT NULL DEFAULT 0,
        pinned    INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parentId);
    `)
    // Add `pinned` to DBs created before the projects navigator existed.
    if (!this.db.prepare('PRAGMA table_info(nodes)').all().some((c: any) => c.name === 'pinned')) {
      this.db.exec('ALTER TABLE nodes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0')
    }
  }

  /** The whole tree, as the flat Node array the app and shared ops expect. */
  load(): Tree {
    const rows = this.db.prepare('SELECT * FROM nodes').all() as Array<{
      id: string
      parentId: string | null
      text: string
      done: number
      order: number
      collapsed: number
      pinned: number
      createdAt: number
    }>
    return rows.map((r) => ({
      id: r.id,
      parentId: r.parentId,
      text: r.text,
      done: !!r.done,
      order: r.order,
      collapsed: !!r.collapsed,
      pinned: !!r.pinned,
      createdAt: r.createdAt,
    }))
  }

  /**
   * Replace the entire nodes table with `tree`, in one transaction. Wholesale
   * rewrite rather than a computed diff: it's cheap at this scale and removes
   * any chance of the DB drifting from the tree the op produced.
   */
  private replace(tree: Tree): Tree {
    const wipe = this.db.prepare('DELETE FROM nodes')
    const insert = this.db.prepare(
      `INSERT INTO nodes (id, parentId, text, done, "order", collapsed, pinned, createdAt)
       VALUES (@id, @parentId, @text, @done, @order, @collapsed, @pinned, @createdAt)`,
    )
    const tx = this.db.transaction((t: Tree) => {
      wipe.run()
      // Parents must exist before children for the FK — insert in depth order.
      // A tree from a pure op is already acyclic; sort roots-first by walking.
      for (const n of sortForInsert(t)) {
        insert.run({
          id: n.id,
          parentId: n.parentId,
          text: n.text,
          done: n.done ? 1 : 0,
          order: n.order,
          collapsed: n.collapsed ? 1 : 0,
          pinned: n.pinned ? 1 : 0,
          createdAt: n.createdAt,
        })
      }
    })
    tx(tree)
    return tree
  }

  // --- atomic operations, each: load → pure op → persist → return new tree ---

  addChild(parentId: NodeId | null, text: string): { tree: Tree; id: NodeId } {
    const { tree, id } = addChild(this.load(), parentId, text)
    return { tree: this.replace(tree), id }
  }

  remove(id: NodeId): Tree {
    return this.replace(removeNode(this.load(), id))
  }

  rename(id: NodeId, text: string): Tree {
    return this.replace(setText(this.load(), id, text))
  }

  setDone(id: NodeId, done: boolean): { tree: Tree; completed: NodeId[] } {
    const { tree, completed } = setDone(this.load(), id, done)
    return { tree: this.replace(tree), completed }
  }

  move(id: NodeId, newParentId: NodeId | null, index: number): Tree {
    return this.replace(moveNode(this.load(), id, newParentId, index))
  }

  toggleCollapsed(id: NodeId): Tree {
    return this.replace(toggleCollapsed(this.load(), id))
  }

  setPinned(id: NodeId, pinned: boolean): Tree {
    return this.replace(setPinned(this.load(), id, pinned))
  }

  /** Overwrite the whole tree — used by import and by first-run seeding. */
  replaceAll(tree: Tree): Tree {
    return this.replace(tree)
  }

  close(): void {
    this.db.close()
  }
}

/**
 * Order nodes parents-before-children so the parentId foreign key is satisfied
 * on insert. Breadth-first from the roots; any node whose parent somehow isn't
 * reachable is appended last so a slightly-off tree still round-trips.
 */
function sortForInsert(tree: Tree): Tree {
  const byParent = new Map<string | null, Tree>()
  for (const n of tree) {
    const key = n.parentId
    const list = byParent.get(key) ?? []
    list.push(n)
    byParent.set(key, list)
  }
  const out: Tree = []
  const seen = new Set<string>()
  const queue = [...(byParent.get(null) ?? [])]
  while (queue.length) {
    const n = queue.shift()!
    if (seen.has(n.id)) continue
    seen.add(n.id)
    out.push(n)
    queue.push(...(byParent.get(n.id) ?? []))
  }
  for (const n of tree) if (!seen.has(n.id)) out.push(n)
  return out
}
