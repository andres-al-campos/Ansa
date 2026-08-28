/**
 * The store, against a Durable Object's SQLite instead of better-sqlite3.
 *
 * Same contract as server/src/store.ts and the same shape for every mutation —
 * load the whole tree, apply a pure op from shared/, persist the result — so
 * the tree logic the app already trusts is still the only thing that edits a
 * tree.
 *
 * ## Ownership is physical here
 *
 * The Node store keeps every owner's rows in one table and filters on ownerId.
 * Here there is one Durable Object per owner, each with its own SQLite
 * database, so this file has no ownerId at all: the isolation is that another
 * owner's rows are in a different database on possibly a different machine,
 * rather than a WHERE clause that has to be right every time.
 *
 * Two consequences worth knowing:
 *
 *  - Node ids only have to be unique within one owner now, not globally. The
 *    primary-key collision that made the local import fail cannot happen. UUIDs
 *    are still worth keeping — a client mints ids offline and they have to not
 *    collide with each other.
 *  - A Durable Object handles one request at a time, so two concurrent writes
 *    from the same account queue instead of racing. The op-replay path already
 *    made that safe; this makes it structural.
 */

import { applyOp, type Op } from '../../shared/ops.ts'
import {
  addChild,
  addSubtree,
  invalidTree,
  markOpened,
  lineageOf,
  moveNode,
  reconcileDone,
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
 * The subset of Durable Object SQL storage this file uses.
 *
 * Declared structurally rather than imported from @cloudflare/workers-types so
 * the store can be unit-tested against a plain better-sqlite3 adapter — the
 * tests then exercise this file's real SQL, not a mock of it.
 */
export interface SqlStorage {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] }
}

interface Row {
  id: string
  parentId: string | null
  text: string
  done: number
  order: number
  collapsed: number
  pinned: number
  lastOpenedAt: number | null
  createdAt: number
}

export class TreeStore {
  constructor(private sql: SqlStorage) {
    // No ownerId column and no index on it: this database holds exactly one
    // owner's nodes. No ON DELETE CASCADE either — replace() rewrites the whole
    // table inside a transaction, so there is never a partial parent delete for
    // a cascade to clean up, and the FK would only constrain insert order.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id        TEXT PRIMARY KEY,
        parentId  TEXT,
        text      TEXT NOT NULL,
        done      INTEGER NOT NULL DEFAULT 0,
        "order"   INTEGER NOT NULL DEFAULT 0,
        collapsed INTEGER NOT NULL DEFAULT 0,
        pinned    INTEGER NOT NULL DEFAULT 0,
        lastOpenedAt INTEGER,
        createdAt INTEGER NOT NULL
      );
    `)
    this.sql.exec('CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parentId);')
  }

  /** This owner's whole tree, as the flat Node array shared/ expects. */
  load(): Tree {
    const rows = this.sql.exec('SELECT * FROM nodes').toArray() as unknown as Row[]
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
   * Replace this database's nodes with `tree`.
   *
   * Wholesale rewrite rather than a computed diff, as in the Node store: the
   * whole tree is a few KB and this removes any chance of the table drifting
   * from the tree the op produced.
   *
   * The caller wraps this in ctx.storage.transactionSync — see AnsaTree. It is
   * not wrapped here because this class is deliberately ignorant of the Durable
   * Object it lives in, which is what lets the tests run it against plain
   * SQLite.
   */
  replace(tree: Tree): Tree {
    this.sql.exec('DELETE FROM nodes')
    for (const n of tree) {
      this.sql.exec(
        `INSERT INTO nodes (id, parentId, text, done, "order", collapsed, pinned, lastOpenedAt, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        n.id,
        n.parentId,
        n.text,
        n.done ? 1 : 0,
        n.order,
        n.collapsed ? 1 : 0,
        n.pinned ? 1 : 0,
        n.lastOpenedAt ?? null,
        n.createdAt,
      )
    }
    return tree
  }

  // --- atomic operations, each: load → pure op → persist → return new tree ---

  /**
   * The MCP tools reach the tree through these rather than through `applyOp`,
   * so each structural one reconciles `done` for itself. Doing it inside
   * `replace` would be tidier but wrong: a whole-tree PUT arrives with the
   * caller's own completion state, which is theirs to set, not ours to derive.
   */
  /**
   * The projects an id sits in, before and after the change — the scope for a
   * reconcile. See `touchedRoots` in shared/ops.ts for why both trees.
   */
  private rootsFor(before: Tree, after: Tree, ...ids: (NodeId | null)[]): NodeId[] {
    const roots = new Set<NodeId>()
    for (const id of ids) {
      if (id === null) continue
      for (const tree of [before, after]) {
        const root = lineageOf(tree, id)[0]
        if (root) roots.add(root.id)
      }
    }
    return [...roots]
  }

  addChild(parentId: NodeId | null, text: string): { tree: Tree; id: NodeId } {
    const tree = this.load()
    requireExistingParent(tree, parentId)
    const added = addChild(tree, parentId, text)
    const scope = this.rootsFor(tree, added.tree, parentId)
    return { tree: this.replace(reconcileDone(added.tree, scope)), id: added.id }
  }

  addSubtree(parentId: NodeId | null, nodes: SubtreeSpec[]): { tree: Tree; ids: NodeId[] } {
    const tree = this.load()
    requireExistingParent(tree, parentId)
    const added = addSubtree(tree, parentId, nodes)
    const scope = this.rootsFor(tree, added.tree, parentId)
    return { tree: this.replace(reconcileDone(added.tree, scope)), ids: added.ids }
  }

  remove(id: NodeId): Tree {
    const tree = this.load()
    const next = removeNode(tree, id)
    return this.replace(reconcileDone(next, this.rootsFor(tree, next, id)))
  }

  rename(id: NodeId, text: string): Tree {
    return this.replace(setText(this.load(), id, text))
  }

  setDone(id: NodeId, done: boolean): { tree: Tree; completed: NodeId[] } {
    const { tree, completed } = setDone(this.load(), id, done)
    return { tree: this.replace(tree), completed }
  }

  move(id: NodeId, newParentId: NodeId | null, index: number): Tree {
    const tree = this.load()
    requireExistingParent(tree, newParentId)
    const next = moveNode(tree, id, newParentId, index)
    return this.replace(reconcileDone(next, this.rootsFor(tree, next, id, newParentId)))
  }

  toggleCollapsed(id: NodeId): Tree {
    return this.replace(toggleCollapsed(this.load(), id))
  }

  setPinned(id: NodeId, pinned: boolean): Tree {
    return this.replace(setPinned(this.load(), id, pinned))
  }

  markOpened(id: NodeId): Tree {
    return this.replace(markOpened(this.load(), id))
  }

  /**
   * Apply a client op against the *current* stored tree.
   *
   * The op is replayed on whatever the tree is now, not on the snapshot the
   * client held when it made the change, so two clients editing different
   * branches both land where a whole-tree write would have let the later one
   * erase the earlier.
   *
   * The invalidTree check stays even though cross-owner links are now
   * impossible: an op naming a parent that doesn't exist still produces a
   * dangling parentId, which orphans a branch out of every view while it sits
   * in the table.
   */
  applyOp(op: Op): { tree: Tree; completed: NodeId[] } {
    const { tree, completed } = applyOp(this.load(), op)
    const bad = invalidTree(tree)
    if (bad) {
      throw new RejectedWriteError(`That change would corrupt the tree (${bad}); nothing was saved.`)
    }
    return { tree: this.replace(tree), completed }
  }

  replaceAll(tree: Tree): Tree {
    const bad = invalidTree(tree)
    if (bad) throw new RejectedWriteError(`That tree is not valid (${bad}); nothing was saved.`)
    return this.replace(tree)
  }
}

/**
 * A write the server refused, as opposed to one that crashed. Routes map this
 * to a 4xx: it means the request was wrong, not that the server is broken.
 */
export class RejectedWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RejectedWriteError'
  }
}

export class UnknownParentError extends RejectedWriteError {
  constructor(parentId: NodeId) {
    super(`No node with id ${parentId} in this tree.`)
    this.name = 'UnknownParentError'
  }
}

/**
 * Reject a parentId that isn't in this tree.
 *
 * In the Node store this also enforced ownership — a parent belonging to
 * someone else read as "not in the tree" because load() had filtered it out.
 * Here that case cannot arise, so this is only what its name says: a guard
 * against a dangling parent.
 */
function requireExistingParent(tree: Tree, parentId: NodeId | null): void {
  if (parentId === null) return
  if (!tree.some((n) => n.id === parentId)) throw new UnknownParentError(parentId)
}
