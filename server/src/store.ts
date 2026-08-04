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
 *
 * ## Ownership
 *
 * Every method takes an `owner` and every statement filters on it. This file is
 * the *only* place ownership exists: shared/tree.ts stays a set of pure
 * functions over a flat array, with no idea that more than one user's nodes
 * were ever in the same table. That boundary is deliberate. If `roots()` or
 * `descendants()` took an ownerId, every future call site would be somewhere a
 * filter could be forgotten — and forgetting it once is a data leak. Here there
 * is one filter to get right, and `load(owner)` hands the tree functions a tree
 * that is already only one person's.
 */

import Database from 'better-sqlite3'
import { applyOp, type Op } from '../../shared/ops.ts'
import {
  addChild,
  addSubtree,
  invalidTree,
  markOpened,
  moveNode,
  removeNode,
  setDone,
  setPinned,
  setText,
  toggleCollapsed,
  type NodeId,
  type SubtreeSpec,
  type Tree,
} from '../../shared/tree.ts'

/**
 * Who a tree belongs to. Opaque here — the server decides what a user id is
 * (today the signed-in user's id); the store only ever compares it for equality.
 */
export type OwnerId = string

/**
 * The owner assigned to rows that predate ownership existing.
 *
 * The database this migration runs against is mine, so backfilling to a
 * placeholder and then claiming it is a step I'd have to remember to do. It is
 * set from ANSA_LEGACY_OWNER instead, so the first deploy can point the existing
 * tree at a real account id in one go.
 */
const LEGACY_OWNER: OwnerId = process.env.ANSA_LEGACY_OWNER ?? 'legacy'

export class Store {
  private db: Database.Database

  constructor(filename: string) {
    this.db = new Database(filename)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id        TEXT PRIMARY KEY,
        ownerId   TEXT NOT NULL,
        parentId  TEXT REFERENCES nodes(id) ON DELETE CASCADE,
        text      TEXT NOT NULL,
        done      INTEGER NOT NULL DEFAULT 0,
        "order"   INTEGER NOT NULL DEFAULT 0,
        collapsed INTEGER NOT NULL DEFAULT 0,
        pinned    INTEGER NOT NULL DEFAULT 0,
        lastOpenedAt INTEGER,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parentId);
    `)
    const columns = this.db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>
    const has = (name: string) => columns.some((c) => c.name === name)
    // Add columns to DBs created before the projects navigator existed.
    if (!has('pinned')) this.db.exec('ALTER TABLE nodes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0')
    if (!has('lastOpenedAt')) this.db.exec('ALTER TABLE nodes ADD COLUMN lastOpenedAt INTEGER')
    // Add ownership to single-user DBs. Every existing row is by definition mine,
    // so they all get the same owner. NOT NULL needs a default to add in place;
    // the literal is safe because it's a constant, not user input.
    if (!has('ownerId')) {
      this.db.exec(
        `ALTER TABLE nodes ADD COLUMN ownerId TEXT NOT NULL DEFAULT '${LEGACY_OWNER.replace(/'/g, "''")}'`,
      )
    }
    // Every query filters on ownerId first, so it leads the index.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_owner ON nodes(ownerId, parentId)')
  }

  /** One owner's whole tree, as the flat Node array the app and shared ops expect. */
  load(owner: OwnerId): Tree {
    const rows = this.db.prepare('SELECT * FROM nodes WHERE ownerId = ?').all(owner) as Array<{
      id: string
      parentId: string | null
      text: string
      done: number
      order: number
      collapsed: number
      pinned: number
      lastOpenedAt: number | null
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
      ...(r.lastOpenedAt != null ? { lastOpenedAt: r.lastOpenedAt } : {}),
      createdAt: r.createdAt,
    }))
  }

  /**
   * Replace one owner's nodes with `tree`, in one transaction. Wholesale
   * rewrite rather than a computed diff: it's cheap at this scale and removes
   * any chance of the DB drifting from the tree the op produced.
   *
   * The delete is scoped to the owner. An unscoped `DELETE FROM nodes` here
   * would wipe every account on any write, so the WHERE clause is the single
   * most load-bearing thing in this file.
   */
  private replace(owner: OwnerId, tree: Tree): Tree {
    const wipe = this.db.prepare('DELETE FROM nodes WHERE ownerId = ?')
    const insert = this.db.prepare(
      `INSERT INTO nodes (id, ownerId, parentId, text, done, "order", collapsed, pinned, lastOpenedAt, createdAt)
       VALUES (@id, @ownerId, @parentId, @text, @done, @order, @collapsed, @pinned, @lastOpenedAt, @createdAt)`,
    )
    const tx = this.db.transaction((t: Tree) => {
      wipe.run(owner)
      // Parents must exist before children for the FK — insert in depth order.
      // A tree from a pure op is already acyclic; sort roots-first by walking.
      for (const n of sortForInsert(t)) {
        insert.run({
          id: n.id,
          ownerId: owner,
          parentId: n.parentId,
          text: n.text,
          done: n.done ? 1 : 0,
          order: n.order,
          collapsed: n.collapsed ? 1 : 0,
          pinned: n.pinned ? 1 : 0,
          lastOpenedAt: n.lastOpenedAt ?? null,
          createdAt: n.createdAt,
        })
      }
    })
    tx(tree)
    return tree
  }

  // --- atomic operations, each: load → pure op → persist → return new tree ---

  addChild(owner: OwnerId, parentId: NodeId | null, text: string): { tree: Tree; id: NodeId } {
    const tree = this.load(owner)
    requireOwnParent(tree, parentId)
    const added = addChild(tree, parentId, text)
    return { tree: this.replace(owner, added.tree), id: added.id }
  }

  addSubtree(owner: OwnerId, parentId: NodeId | null, nodes: SubtreeSpec[]): { tree: Tree; ids: NodeId[] } {
    const tree = this.load(owner)
    requireOwnParent(tree, parentId)
    const added = addSubtree(tree, parentId, nodes)
    return { tree: this.replace(owner, added.tree), ids: added.ids }
  }

  remove(owner: OwnerId, id: NodeId): Tree {
    return this.replace(owner, removeNode(this.load(owner), id))
  }

  rename(owner: OwnerId, id: NodeId, text: string): Tree {
    return this.replace(owner, setText(this.load(owner), id, text))
  }

  setDone(owner: OwnerId, id: NodeId, done: boolean): { tree: Tree; completed: NodeId[] } {
    const { tree, completed } = setDone(this.load(owner), id, done)
    return { tree: this.replace(owner, tree), completed }
  }

  move(owner: OwnerId, id: NodeId, newParentId: NodeId | null, index: number): Tree {
    const tree = this.load(owner)
    requireOwnParent(tree, newParentId)
    return this.replace(owner, moveNode(tree, id, newParentId, index))
  }

  toggleCollapsed(owner: OwnerId, id: NodeId): Tree {
    return this.replace(owner, toggleCollapsed(this.load(owner), id))
  }

  setPinned(owner: OwnerId, id: NodeId, pinned: boolean): Tree {
    return this.replace(owner, setPinned(this.load(owner), id, pinned))
  }

  markOpened(owner: OwnerId, id: NodeId): Tree {
    return this.replace(owner, markOpened(this.load(owner), id))
  }

  /**
   * Apply a client op against the *current* stored tree.
   *
   * This is the write path that makes concurrent edits safe: the op is replayed
   * on whatever the tree is now, not on the snapshot the client held when it
   * made the change. Two clients editing different branches therefore both land,
   * where a whole-tree write would have let the later one erase the earlier.
   *
   * An op names node ids the caller picked, so a caller could name someone
   * else's node — but `load(owner)` hands the op a tree those ids aren't in, so
   * the pure op finds nothing and no-ops. The isolation comes from the filtered
   * load rather than from checking each id, which is why it can't be forgotten
   * for one op and not another.
   */
  applyOp(owner: OwnerId, op: Op): { tree: Tree; completed: NodeId[] } {
    const { tree, completed } = applyOp(this.load(owner), op)
    // Several ops carry a caller-chosen parentId (addChild, addSubtree,
    // moveNode). Pointed at a node this owner doesn't have, the pure op happily
    // produces a tree with a dangling parentId — which, if that id is another
    // account's real row, persists as a live cross-owner link. Checking the
    // result rather than each op's parentId means every op is covered by one
    // check, including any added later.
    const bad = invalidTree(tree)
    if (bad) throw new RejectedWriteError(`That change would corrupt the tree (${bad}); nothing was saved.`)
    return { tree: this.replace(owner, tree), completed }
  }

  /** Overwrite one owner's tree — used by import and by first-run seeding. */
  replaceAll(owner: OwnerId, tree: Tree): Tree {
    return this.replace(owner, tree)
  }

  /**
   * Fold the write-ahead log back into the database file and reset it to empty.
   *
   * WAL's own autocheckpoint runs at 1000 pages, but it can only reclaim the
   * part of the log no reader still needs — and this process keeps a connection
   * open continuously for the SSE subscribers, so in practice the log is never
   * fully reset and grows without bound. A 24KB database fronted by a 4MB WAL
   * is the observed result.
   *
   * TRUNCATE rather than PASSIVE because reclaiming the file is the whole point.
   * It gives up rather than blocking if a reader is mid-read, which is why this
   * is safe to call on a timer: a skipped checkpoint just means the next one
   * does the work.
   */
  checkpoint(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)')
  }

  close(): void {
    // Checkpoint first: a clean shutdown should leave the database standing on
    // its own rather than needing the -wal file to be complete.
    this.checkpoint()
    this.db.close()
  }
}

/**
 * A write the store refused. The routes turn this into a 400 — it means the
 * request was bad, not that the server broke.
 */
export class RejectedWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RejectedWriteError'
  }
}

/** Raised when a request names a parent node the owner doesn't have. */
export class UnknownParentError extends RejectedWriteError {
  constructor(parentId: NodeId) {
    super(`No such parent task: ${parentId}. Check the id, or pass null to make a new project.`)
    this.name = 'UnknownParentError'
  }
}

/**
 * Reject a parentId that isn't in this owner's tree.
 *
 * The pure tree functions don't require a parent to exist: `addChild` appends a
 * node carrying whatever parentId it was given, and `moveNode` reparents onto
 * one. With a single user that was harmless, because a missing id meant a typo
 * and produced an orphan. With accounts it isn't: the id might be a *real* row
 * belonging to someone else, and the write would store a live cross-owner
 * parentId — a tree that fails its own validator, and one that a stranger's
 * delete would cascade into.
 *
 * The filtered load is what makes this checkable here: a parent the owner can't
 * see isn't in `tree`, so "exists" and "is mine" are the same question.
 */
function requireOwnParent(tree: Tree, parentId: NodeId | null): void {
  if (parentId === null) return
  if (!tree.some((n) => n.id === parentId)) throw new UnknownParentError(parentId)
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
