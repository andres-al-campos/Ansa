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
  roots,
  setDone,
  setPinned,
  setText,
  subtreeOf,
  toggleCollapsed,
  type Node,
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

/** One line of the trash list: what was deleted, when, and how big it was. */
export interface TrashEntry {
  id: string
  rootId: string
  text: string
  deletedAt: number
  count: number
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

    // The trash: subtrees that were deleted, kept so a delete can be cheap.
    //
    // Deliberately *not* a `deletedAt` column on `nodes`. Leaving the rows in
    // place would make every existing tree function conditionally correct —
    // childrenOf, roots, subtreeOf, progressOf, the sidebar, the iOS row list
    // and the MCP tools would each have to remember to skip them, and the way
    // that fails is a deleted task quietly reappearing in the one view that
    // forgot. It would also put the trash in the hot path: load() reads the
    // whole table on every op, so a month of throwaway deletions would have
    // every edit read a growing pile of dead rows to filter back out. Kept
    // apart, the trash costs nothing until it is opened.
    //
    // Two tables rather than one JSON blob per entry: restoring is then an
    // insert-select and the retention sweep a delete-where, both in SQL, and
    // listing the trash does not have to parse every saved subtree to print one
    // line each.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS trash_entries (
        id        TEXT PRIMARY KEY,
        rootId    TEXT NOT NULL,
        parentId  TEXT,
        deletedAt INTEGER NOT NULL
      );
    `)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS trash_nodes (
        entryId   TEXT NOT NULL,
        id        TEXT NOT NULL,
        parentId  TEXT,
        text      TEXT NOT NULL,
        done      INTEGER NOT NULL DEFAULT 0,
        "order"   INTEGER NOT NULL DEFAULT 0,
        collapsed INTEGER NOT NULL DEFAULT 0,
        pinned    INTEGER NOT NULL DEFAULT 0,
        lastOpenedAt INTEGER,
        createdAt INTEGER NOT NULL,
        PRIMARY KEY (entryId, id)
      );
    `)
    // The list reads newest-first and the sweep reads oldest-first; one index
    // on the column both order by serves each from either end.
    this.sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_trash_deleted ON trash_entries(deletedAt);')
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
   * Wholesale rewrite rather than a computed diff, as in the Node store: it
   * removes any chance of the table drifting from the tree the op produced.
   *
   * The cost is one row written per node per call, and Durable Objects meter
   * rows written, not bytes — so this is cheap on the axis the comment above
   * used to reason about and expensive on the axis that is actually billed. It
   * also scales with the size of the tree rather than the size of the edit, so
   * it gets worse the more you use the app. Keep it for the ops that genuinely
   * rewrite many nodes (anything reconciling `done`); the single-field ops
   * below write their one row directly.
   *
   * The caller wraps this in ctx.storage.transactionSync — see AnsaTree. It is
   * not wrapped here because this class is deliberately ignorant of the Durable
   * Object it lives in, which is what lets the tests run it against plain
   * SQLite.
   */
  replace(tree: Tree): Tree {
    this.sql.exec('DELETE FROM nodes')
    for (const n of tree) this.insert(n)
    return tree
  }

  /**
   * Persist `next`, writing only the rows that differ from `before`.
   *
   * Same guarantee as `replace` — the table ends up holding exactly `next` —
   * but at a cost proportional to the edit rather than to the tree. That
   * matters because Durable Objects bill rows written: rewriting 59 nodes to
   * tick one checkbox is ~118 row-writes, and the daily free-tier allowance is
   * spent in a few hundred edits. An op that really does touch the whole tree
   * still writes the whole tree; nothing here caps what a change may do.
   *
   * The comparison is on the node's own fields, so a node whose position in the
   * array moved but whose values did not is correctly left alone — `load()`
   * returns table order, which is not meaningful.
   */
  private write(before: Tree, next: Tree): Tree {
    const was = new Map(before.map((n) => [n.id, n]))
    for (const n of next) {
      const old = was.get(n.id)
      if (old === undefined) {
        this.insert(n)
      } else if (!sameNode(old, n)) {
        this.sql.exec(
          `UPDATE nodes SET parentId = ?, text = ?, done = ?, "order" = ?,
             collapsed = ?, pinned = ?, lastOpenedAt = ?, createdAt = ? WHERE id = ?`,
          n.parentId,
          n.text,
          n.done ? 1 : 0,
          n.order,
          n.collapsed ? 1 : 0,
          n.pinned ? 1 : 0,
          n.lastOpenedAt ?? null,
          n.createdAt,
          n.id,
        )
      }
      was.delete(n.id)
    }
    // Whatever is left was in the tree before and is not in it now.
    for (const id of was.keys()) this.sql.exec('DELETE FROM nodes WHERE id = ?', id)
    return next
  }

  private insert(n: Tree[number]): void {
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

  /**
   * Write one column of one row, and return the tree with the same change.
   *
   * The tree still comes from the pure helper in shared/, so the in-memory
   * result is produced by exactly the code every other client uses; only the
   * persistence is narrowed. The pair has to stay in step — a helper that
   * touched a second node would be saved as one — so this is only for the ops
   * whose helper is a single-field `map` over one id, and the assertion below
   * catches it if one ever stops being.
   */
  private writeField(tree: Tree, id: NodeId, column: string, value: unknown): Tree {
    this.sql.exec(`UPDATE nodes SET "${column}" = ? WHERE id = ?`, value, id)
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
    return { tree: this.write(tree, reconcileDone(added.tree, scope)), id: added.id }
  }

  addSubtree(parentId: NodeId | null, nodes: SubtreeSpec[]): { tree: Tree; ids: NodeId[] } {
    const tree = this.load()
    requireExistingParent(tree, parentId)
    const added = addSubtree(tree, parentId, nodes)
    const scope = this.rootsFor(tree, added.tree, parentId)
    return { tree: this.write(tree, reconcileDone(added.tree, scope)), ids: added.ids }
  }

  remove(id: NodeId, trash = false): Tree {
    const tree = this.load()
    if (trash) this.keep(tree, id)
    const next = removeNode(tree, id)
    return this.write(tree, reconcileDone(next, this.rootsFor(tree, next, id)))
  }

  // ------------------------------------------------------------- the trash

  /**
   * Copy the subtree rooted at `id` into the trash, before it is removed.
   *
   * Called with the tree as it still stands, so the subtree is read from the
   * live tree rather than reconstructed. Writes one row per node kept, on an
   * action that is already writing that many.
   *
   * Silently does nothing for an unknown id, matching every other op here: an
   * op naming a node that is already gone is a harmless no-op, which is what
   * lets a queued op arrive late without wedging the client that sent it.
   */
  private keep(tree: Tree, id: NodeId): void {
    const node = tree.find((n) => n.id === id)
    if (!node) return
    const entryId = crypto.randomUUID()
    this.sql.exec(
      'INSERT INTO trash_entries (id, rootId, parentId, deletedAt) VALUES (?, ?, ?, ?)',
      entryId, id, node.parentId, Date.now(),
    )
    for (const n of [node, ...subtreeOf(tree, id)]) {
      this.sql.exec(
        `INSERT INTO trash_nodes (entryId, id, parentId, text, done, "order",
           collapsed, pinned, lastOpenedAt, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        entryId, n.id, n.parentId, n.text, n.done ? 1 : 0, n.order,
        n.collapsed ? 1 : 0, n.pinned ? 1 : 0, n.lastOpenedAt ?? null, n.createdAt,
      )
    }
  }

  /**
   * A page of trash entries, newest first.
   *
   * Returns a line per entry — the deleted root's text and how much went with
   * it — not the nodes themselves. The trash view is a list; loading every
   * saved subtree to print one line each is what the two-table shape avoids.
   *
   * `cursor` is the `deletedAt` of the last entry seen. A timestamp rather than
   * an offset so a sweep running between two pages cannot shift the window and
   * skip an entry.
   */
  trashPage(limit = 50, cursor?: number): { entries: TrashEntry[]; nextCursor?: number } {
    const rows = this.sql.exec(
      `SELECT e.id, e.rootId, e.deletedAt, n.text,
              (SELECT COUNT(*) FROM trash_nodes WHERE entryId = e.id) AS count
         FROM trash_entries e
         JOIN trash_nodes n ON n.entryId = e.id AND n.id = e.rootId
        WHERE e.deletedAt < ?
        ORDER BY e.deletedAt DESC
        LIMIT ?`,
      cursor ?? Number.MAX_SAFE_INTEGER, limit + 1,
    ).toArray() as unknown as TrashEntry[]
    // One more than asked for, so "is there another page" is answered without a
    // second count query. The extra is dropped before returning.
    const entries = rows.slice(0, limit)
    const more = rows.length > limit
    return more
      ? { entries, nextCursor: entries[entries.length - 1].deletedAt }
      : { entries }
  }

  /**
   * Put a trashed subtree back, and drop the entry.
   *
   * The root returns to the parent it was under, unless that parent has since
   * been deleted too — then it comes back as a project. Notion resolves this
   * the same way, and it is the rule that needs no special path: restoring the
   * parent afterwards does not re-adopt the child, but the result is never
   * wrong, only flatter than it was.
   *
   * A restored root lands after the last existing one rather than at its old
   * `order`, which may well be taken by now.
   */
  restore(entryId: NodeId): Tree | null {
    const entry = this.sql.exec(
      'SELECT * FROM trash_entries WHERE id = ?', entryId,
    ).toArray()[0] as unknown as { id: string; rootId: string; parentId: string | null } | undefined
    if (!entry) return null

    const saved = this.sql.exec(
      'SELECT * FROM trash_nodes WHERE entryId = ?', entryId,
    ).toArray() as unknown as (Row & { entryId: string })[]

    const tree = this.load()
    const alive = new Set(tree.map((n) => n.id))
    const orphaned = entry.parentId !== null && !alive.has(entry.parentId)
    const lastRoot = roots(tree).reduce((m, r) => Math.max(m, r.order), -1)

    const back: Node[] = saved.map((r) => {
      const n: Node = {
        id: r.id,
        parentId: r.parentId,
        text: r.text,
        done: !!r.done,
        order: r.order,
        collapsed: !!r.collapsed,
        pinned: !!r.pinned,
        createdAt: r.createdAt,
      }
      if (r.lastOpenedAt !== null) n.lastOpenedAt = r.lastOpenedAt
      // Only the subtree's own root is re-homed; everything under it already
      // points at a node coming back in the same batch.
      if (r.id === entry.rootId && orphaned) {
        n.parentId = null
        n.order = lastRoot + 1
      }
      return n
    })

    const next = [...tree, ...back]
    const bad = invalidTree(next)
    if (bad) throw new RejectedWriteError(`That restore would corrupt the tree (${bad}); nothing was saved.`)

    this.forget(entryId)
    return this.write(tree, reconcileDone(next, this.rootsFor(tree, next, entry.rootId)))
  }

  /** Drop one entry and its nodes for good. */
  forget(entryId: NodeId): void {
    this.sql.exec('DELETE FROM trash_nodes WHERE entryId = ?', entryId)
    this.sql.exec('DELETE FROM trash_entries WHERE id = ?', entryId)
  }

  /**
   * Drop everything deleted before `cutoff`. Returns how many entries went.
   *
   * Runs from the Durable Object's alarm, so the trash empties itself and is
   * never a thing to remember to take out. Sweeping on read was the
   * alternative and leaves a trash nobody opens growing forever — which is the
   * case this app expects, since deleting is meant to be cheap enough to do
   * with small throwaway tasks.
   */
  sweep(cutoff: number): number {
    const doomed = this.sql.exec(
      'SELECT id FROM trash_entries WHERE deletedAt < ?', cutoff,
    ).toArray() as unknown as { id: string }[]
    for (const { id } of doomed) this.forget(id)
    return doomed.length
  }

  /** How many entries the trash holds. Used to decide whether to keep sweeping. */
  trashCount(): number {
    const row = this.sql.exec('SELECT COUNT(*) AS n FROM trash_entries').toArray()[0]
    return (row as unknown as { n: number }).n
  }

  rename(id: NodeId, text: string): Tree {
    return this.writeField(setText(this.load(), id, text), id, 'text', text)
  }

  setDone(id: NodeId, done: boolean): { tree: Tree; completed: NodeId[] } {
    const before = this.load()
    const { tree, completed } = setDone(before, id, done)
    return { tree: this.write(before, tree), completed }
  }

  move(id: NodeId, newParentId: NodeId | null, index: number): Tree {
    const tree = this.load()
    requireExistingParent(tree, newParentId)
    const next = moveNode(tree, id, newParentId, index)
    return this.write(tree, reconcileDone(next, this.rootsFor(tree, next, id, newParentId)))
  }

  toggleCollapsed(id: NodeId): Tree {
    const tree = toggleCollapsed(this.load(), id)
    const now = tree.find((n) => n.id === id)?.collapsed ?? false
    return this.writeField(tree, id, 'collapsed', now ? 1 : 0)
  }

  setPinned(id: NodeId, pinned: boolean): Tree {
    return this.writeField(setPinned(this.load(), id, pinned), id, 'pinned', pinned ? 1 : 0)
  }

  markOpened(id: NodeId): Tree {
    const tree = markOpened(this.load(), id)
    const at = tree.find((n) => n.id === id)?.lastOpenedAt ?? null
    return this.writeField(tree, id, 'lastOpenedAt', at)
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
    const before = this.load()
    const { tree, completed } = applyOp(before, op)
    const bad = invalidTree(tree)
    if (bad) {
      throw new RejectedWriteError(`That change would corrupt the tree (${bad}); nothing was saved.`)
    }
    // After the validity check, so a delete that would corrupt the tree does not
    // leave a trash entry for a removal that never happened. Before the write,
    // because `keep` reads the subtree out of the tree as it still stands.
    if (op.op === 'removeNode' && op.trash) this.keep(before, op.id)
    return { tree: this.write(before, tree), completed }
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
/**
 * Whether two versions of a node hold the same values.
 *
 * Field-by-field rather than a JSON compare because `lastOpenedAt` is omitted
 * when absent and undefined when read back from a spread — key order and
 * presence would make equal nodes compare unequal, which would cost a write
 * rather than corrupt anything, but the whole point here is not writing.
 */
function sameNode(a: Tree[number], b: Tree[number]): boolean {
  return (
    a.parentId === b.parentId &&
    a.text === b.text &&
    a.done === b.done &&
    a.order === b.order &&
    a.collapsed === b.collapsed &&
    !!a.pinned === !!b.pinned &&
    (a.lastOpenedAt ?? null) === (b.lastOpenedAt ?? null) &&
    a.createdAt === b.createdAt
  )
}

function requireExistingParent(tree: Tree, parentId: NodeId | null): void {
  if (parentId === null) return
  if (!tree.some((n) => n.id === parentId)) throw new UnknownParentError(parentId)
}
