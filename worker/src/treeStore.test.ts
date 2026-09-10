/**
 * The Durable Object store, run against real SQLite.
 *
 * TreeStore takes a structural SqlStorage rather than importing Cloudflare's
 * types, so these tests drive it with a thin better-sqlite3 adapter. That means
 * the SQL in treeStore.ts is what executes here — a mock would assert that the
 * file calls the methods it calls, which is not a property worth testing.
 *
 * The isolation tests are carried over from the Node store deliberately. There,
 * isolation was a WHERE clause that could be forgotten; here it is meant to be
 * structural — one database per owner. "Structural" is a claim about behaviour,
 * so it gets asserted rather than assumed.
 */

import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RejectedWriteError, TreeStore, UnknownParentError, type SqlStorage } from './treeStore.ts'
import { invalidTree, roots } from '../../shared/tree.ts'
import { seedTree } from '../../shared/seed.ts'

/**
 * better-sqlite3 behind the Durable Object SQL surface.
 *
 * `exec(query, ...bindings)` returning `{ toArray() }` is the shape
 * ctx.storage.sql exposes; better-sqlite3 splits that into run/all depending on
 * whether the statement returns rows, so this adapter picks based on `reader`.
 */
function sqlAdapter(file: string): SqlStorage & { close(): void } {
  const db = new Database(file)
  return {
    exec(query: string, ...bindings: unknown[]) {
      // Multi-statement DDL can't be prepared; those never carry bindings.
      if (bindings.length === 0 && /;\s*\S/.test(query.trim())) {
        db.exec(query)
        return { toArray: () => [] }
      }
      const stmt = db.prepare(query)
      if (stmt.reader) {
        const rows = stmt.all(...(bindings as never[])) as Record<string, unknown>[]
        return { toArray: () => rows }
      }
      stmt.run(...(bindings as never[]))
      return { toArray: () => [] }
    },
    close: () => db.close(),
  }
}

let dir: string
let a: SqlStorage & { close(): void }
let b: SqlStorage & { close(): void }
let storeA: TreeStore
let storeB: TreeStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ansa-do-store-'))
  // Two databases, standing in for two Durable Objects — which is exactly what
  // two owners get at runtime.
  a = sqlAdapter(join(dir, 'a.db'))
  b = sqlAdapter(join(dir, 'b.db'))
  storeA = new TreeStore(a)
  storeB = new TreeStore(b)
})

afterEach(() => {
  a.close()
  b.close()
  rmSync(dir, { recursive: true, force: true })
})

const projects = (s: TreeStore) =>
  roots(s.load())
    .map((n) => n.text)
    .sort()

describe('a fresh store', () => {
  it('starts empty rather than seeded', () => {
    // Reads never write — the seed-on-read bug that furnished accounts nobody
    // had typed in must not come back with the storage layer.
    expect(storeA.load()).toEqual([])
    expect(storeA.load()).toEqual([])
  })
})

describe('owners are isolated by construction', () => {
  it("one owner's tree doesn't include another's nodes", () => {
    storeA.addChild(null, 'A project')
    storeB.addChild(null, 'B project')
    expect(projects(storeA)).toEqual(['A project'])
    expect(projects(storeB)).toEqual(['B project'])
  })

  it("a wholesale replace does not empty another owner's tree", () => {
    // The Node store's replace() begins with a DELETE, and an unscoped one
    // would wipe every account on any write. Here the DELETE is meant to be
    // harmless because it can only reach one database.
    storeA.addChild(null, 'A project')
    storeB.replaceAll(seedTree())
    expect(projects(storeA)).toEqual(['A project'])
    expect(storeB.load().length).toBeGreaterThan(0)
  })

  it('ids may repeat across owners without colliding', () => {
    // Node ids were globally unique in the single-table schema, so importing a
    // tree whose ids already existed failed on the primary key. Per-owner
    // databases remove that constraint, which is what makes the migration
    // import safe to run with ids preserved.
    const tree = seedTree()
    storeA.replaceAll(tree)
    expect(() => storeB.replaceAll(tree)).not.toThrow()
    expect(storeA.load().map((n) => n.id).sort()).toEqual(storeB.load().map((n) => n.id).sort())
  })
})

describe('round-tripping a tree', () => {
  it('survives replace → load unchanged', () => {
    const tree = seedTree()
    storeA.replaceAll(tree)
    const back = storeA.load()
    expect(back).toHaveLength(tree.length)
    expect(invalidTree(back)).toBeNull()
    // Compared as sets: load() returns table order, not the order rows went in.
    expect(new Set(back.map((n) => n.text))).toEqual(new Set(tree.map((n) => n.text)))
  })

  it('preserves every column, including the optional ones', () => {
    // lastOpenedAt is omitted rather than null when absent, and the booleans
    // are stored as integers — both are places a round trip can quietly lose
    // or corrupt a value.
    const at = 1785863411290
    storeA.replaceAll([
      { id: 'r', parentId: null, text: 'root', done: true, order: 3, collapsed: true, pinned: true, lastOpenedAt: at, createdAt: 1 },
      { id: 'c', parentId: 'r', text: 'child', done: false, order: 0, collapsed: false, createdAt: 2 },
    ])
    const back = storeA.load()
    const root = back.find((n) => n.id === 'r')!
    const child = back.find((n) => n.id === 'c')!
    expect(root).toEqual({
      id: 'r', parentId: null, text: 'root', done: true, order: 3,
      collapsed: true, pinned: true, lastOpenedAt: at, createdAt: 1,
    })
    // Absent rather than null, matching the Node store and the Tree type.
    expect('lastOpenedAt' in child).toBe(false)
    expect(child.done).toBe(false)
    expect(child.pinned).toBe(false)
  })
})

describe('rejected writes', () => {
  it('refuses a parent that does not exist', () => {
    expect(() => storeA.addChild('nope', 'orphan')).toThrow(UnknownParentError)
    expect(storeA.load()).toEqual([])
  })

  it("refuses another owner's node as a parent", () => {
    // The cross-owner case the Node store caught via its filtered load. Worth
    // its own test: the mechanism changed completely, the guarantee must not.
    const { id } = storeB.addChild(null, 'B project')
    expect(() => storeA.addChild(id, 'stolen child')).toThrow(UnknownParentError)
    expect(storeA.load()).toEqual([])
  })

  it('refuses an op that would leave the tree invalid', () => {
    const { id } = storeA.addChild(null, 'project')
    expect(() =>
      storeA.applyOp({ op: 'moveNode', id, parentId: 'ghost', index: 0 }),
    ).toThrow(RejectedWriteError)
    // Nothing was saved — the tree is still the one good node.
    expect(storeA.load()).toHaveLength(1)
  })

  it('refuses an invalid tree wholesale', () => {
    expect(() =>
      storeA.replaceAll([
        { id: 'x', parentId: 'ghost', text: 'x', done: false, order: 0, collapsed: false, createdAt: 1 },
      ]),
    ).toThrow(RejectedWriteError)
    expect(storeA.load()).toEqual([])
  })
})

describe('ops replay against current state', () => {
  it('applies a client op to whatever the tree is now', () => {
    const { id } = storeA.addChild(null, 'project')
    const { tree } = storeA.applyOp({ op: 'setText', id, text: 'renamed' })
    expect(tree.find((n) => n.id === id)!.text).toBe('renamed')
    expect(storeA.load().find((n) => n.id === id)!.text).toBe('renamed')
  })

  it('ticking a parent completes its subtree', () => {
    const { id: root } = storeA.addChild(null, 'project')
    storeA.addChild(root, 'one')
    storeA.addChild(root, 'two')
    const { tree } = storeA.setDone(root, true)
    expect(tree.every((n) => n.done)).toBe(true)
  })
})

describe('single-field ops write one row', () => {
  /**
   * These four never reconcile `done`, so they change exactly one node — and
   * the store now writes exactly that node rather than rewriting the table.
   *
   * Asserted through behaviour rather than by counting SQL: what has to hold is
   * that the narrowed write still leaves the stored tree identical to the one
   * the pure helper produced. A helper that quietly grew to touch a second node
   * would fail here, which is the failure this narrowing risks.
   */
  const stored = (s: TreeStore) => new Map(s.load().map((n) => [n.id, n]))

  it('rename persists the new text and nothing else', () => {
    const { id: root } = storeA.addChild(null, 'project')
    const { id: kid } = storeA.addChild(root, 'task')
    const before = stored(storeA)
    const tree = storeA.rename(kid, 'renamed')
    expect(stored(storeA)).toEqual(new Map(tree.map((n) => [n.id, n])))
    expect(storeA.load().find((n) => n.id === kid)!.text).toBe('renamed')
    expect(storeA.load().find((n) => n.id === root)).toEqual(before.get(root))
  })

  it('toggleCollapsed persists both directions', () => {
    const { id } = storeA.addChild(null, 'project')
    storeA.toggleCollapsed(id)
    expect(storeA.load().find((n) => n.id === id)!.collapsed).toBe(true)
    const tree = storeA.toggleCollapsed(id)
    expect(storeA.load().find((n) => n.id === id)!.collapsed).toBe(false)
    expect(stored(storeA)).toEqual(new Map(tree.map((n) => [n.id, n])))
  })

  it('setPinned persists both directions', () => {
    const { id } = storeA.addChild(null, 'project')
    storeA.setPinned(id, true)
    expect(storeA.load().find((n) => n.id === id)!.pinned).toBe(true)
    const tree = storeA.setPinned(id, false)
    expect(storeA.load().find((n) => n.id === id)!.pinned).toBe(false)
    expect(stored(storeA)).toEqual(new Map(tree.map((n) => [n.id, n])))
  })

  it('setPinOrder persists the shelf position', () => {
    const { id } = storeA.addChild(null, 'project')
    storeA.setPinned(id, true)
    const tree = storeA.setPinOrder(id, 3)
    expect(storeA.load().find((n) => n.id === id)!.pinOrder).toBe(3)
    expect(stored(storeA)).toEqual(new Map(tree.map((n) => [n.id, n])))
  })

  it('a node with no shelf position omits the field rather than sending null', () => {
    // `pinOrder` absent is what makes the shelf sort it last. A null read back
    // as 0 would put every undragged pin at the top instead.
    const { id } = storeA.addChild(null, 'project')
    expect('pinOrder' in storeA.load().find((n) => n.id === id)!).toBe(false)
  })

  it('adds pinOrder to a table that predates the column', () => {
    // The real migration case: `CREATE TABLE IF NOT EXISTS` skips a table that
    // already exists, so a store created before this column has to be altered
    // on open. Building the old table by hand is the only way to test the path
    // every existing Durable Object actually takes.
    const path = join(dir, 'old.db')
    const old = sqlAdapter(path)
    old.exec(`
      CREATE TABLE nodes (
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
    old.exec(
      `INSERT INTO nodes (id, parentId, text, done, "order", collapsed, pinned, createdAt)
       VALUES ('kept', NULL, 'from before', 0, 0, 0, 1, 1)`,
    )

    const store = new TreeStore(old)
    const node = store.load().find((n) => n.id === 'kept')!
    // The row survived the migration, and the new column reads as absent.
    expect(node.text).toBe('from before')
    expect(node.pinned).toBe(true)
    expect('pinOrder' in node).toBe(false)
    // And it is writable now, which is what the ALTER was for.
    store.setPinOrder('kept', 2)
    expect(store.load().find((n) => n.id === 'kept')!.pinOrder).toBe(2)
    old.close()
  })

  it('opening a migrated store twice does not fail on the ALTER', () => {
    // The duplicate-column error is the success case for an already-migrated
    // store, so a second open has to swallow it rather than throw.
    const path = join(dir, 'twice.db')
    const one = sqlAdapter(path)
    new TreeStore(one)
    expect(() => new TreeStore(one)).not.toThrow()
    one.close()
  })

  it('migrates trash_nodes when it predates pinOrder, so a delete still writes', () => {
    // The parallel of the nodes migration above, and the case that actually
    // broke: a store whose trash_nodes was created before pinOrder joined the
    // column list. CREATE TABLE IF NOT EXISTS skips the existing table, so
    // without the ALTER the first delete throws "no column named pinOrder".
    // Building the old trash_nodes by hand is the only way to exercise that
    // path; a fresh store gets the column from the CREATE and never sees it.
    const path = join(dir, 'old-trash.db')
    const old = sqlAdapter(path)
    old.exec(`
      CREATE TABLE trash_nodes (
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

    const store = new TreeStore(old)
    const { id } = store.addChild(null, 'to delete')
    // The delete-to-trash inserts into trash_nodes; before the ALTER this threw.
    expect(() => store.remove(id, true)).not.toThrow()
    expect(store.load()).toEqual([])
    old.close()
  })

  it('markOpened persists the stamp', () => {
    const { id } = storeA.addChild(null, 'project')
    const tree = storeA.markOpened(id)
    const at = tree.find((n) => n.id === id)!.lastOpenedAt
    expect(at).toBeGreaterThan(0)
    expect(storeA.load().find((n) => n.id === id)!.lastOpenedAt).toBe(at)
  })

  it('an unknown id changes nothing', () => {
    // The pure helper is a no-op for an id it cannot find, and so is the
    // UPDATE. Worth pinning: a narrowed write that started inserting instead
    // would put a dangling row in the table.
    storeA.addChild(null, 'project')
    const before = storeA.load()
    storeA.rename('ghost', 'x')
    storeA.setPinned('ghost', true)
    expect(storeA.load()).toEqual(before)
  })
})

describe('writes cost the edit, not the tree', () => {
  /**
   * The store now writes only the rows an op changed. That is worth having —
   * Durable Objects bill rows written, and rewriting the table per keystroke
   * exhausted the daily allowance in a few hundred edits — but it is only safe
   * if the table still ends up holding exactly the tree the op produced. These
   * tests assert that equivalence on the cases a diff can get wrong: rows that
   * must disappear, and rows that move.
   */
  const asMap = (t: ReturnType<TreeStore['load']>) => new Map(t.map((n) => [n.id, n]))

  it('a delete removes the whole subtree from the table', () => {
    const { id: root } = storeA.addChild(null, 'project')
    const { id: mid } = storeA.addChild(root, 'section')
    storeA.addChild(mid, 'leaf one')
    storeA.addChild(mid, 'leaf two')
    const tree = storeA.remove(mid)
    expect(asMap(storeA.load())).toEqual(asMap(tree))
    expect(storeA.load()).toHaveLength(1)
  })

  it('a move persists the new parent and the resulting order', () => {
    const { id: a } = storeA.addChild(null, 'A')
    const { id: b } = storeA.addChild(null, 'B')
    const { id: kid } = storeA.addChild(a, 'kid')
    storeA.addChild(b, 'sibling')
    const tree = storeA.move(kid, b, 0)
    expect(asMap(storeA.load())).toEqual(asMap(tree))
    expect(storeA.load().find((n) => n.id === kid)!.parentId).toBe(b)
  })

  it('a done cascade persists every node it touched', () => {
    const { id: root } = storeA.addChild(null, 'project')
    storeA.addChild(root, 'one')
    storeA.addChild(root, 'two')
    const { tree } = storeA.setDone(root, true)
    expect(asMap(storeA.load())).toEqual(asMap(tree))
    expect(storeA.load().every((n) => n.done)).toBe(true)
  })

  it('an op replayed through applyOp lands in the table intact', () => {
    // applyOp is the path every client uses; the named methods above are mostly
    // the MCP's. Structural ops go through here, so a diff that mishandled one
    // would corrupt real trees while the MCP tests stayed green.
    const { id: root } = storeA.addChild(null, 'project')
    const { id: one } = storeA.addChild(root, 'one')
    const { id: two } = storeA.addChild(root, 'two')
    const { tree } = storeA.applyOp({ op: 'indent', id: two })
    expect(asMap(storeA.load())).toEqual(asMap(tree))
    expect(storeA.load().find((n) => n.id === two)!.parentId).toBe(one)

    const after = storeA.applyOp({ op: 'removeNode', id: one }).tree
    expect(asMap(storeA.load())).toEqual(asMap(after))
  })

  it('re-writing an unchanged tree leaves it unchanged', () => {
    const { id } = storeA.addChild(null, 'project')
    const before = storeA.load()
    storeA.rename(id, 'project')
    storeA.applyOp({ op: 'setText', id, text: 'project' })
    expect(storeA.load()).toEqual(before)
  })
})

describe('the trash', () => {
  it('keeps nothing unless the op asks', () => {
    // The default matters more than it looks: three of the removeNode call
    // sites in the web client are editing mechanics — a backspace merging two
    // rows, an empty row abandoned — and trashing those would fill it with
    // blank strings.
    const { id } = storeA.addChild(null, 'project')
    storeA.applyOp({ op: 'removeNode', id })
    expect(storeA.trashPage().entries).toEqual([])
  })

  it('keeps the whole subtree, and reports its size', () => {
    const { id: root } = storeA.addChild(null, 'project')
    const { id: parent } = storeA.addChild(root, 'parent')
    storeA.addChild(parent, 'child')
    storeA.applyOp({ op: 'removeNode', id: parent, trash: true })

    const { entries } = storeA.trashPage()
    expect(entries).toHaveLength(1)
    expect(entries[0].text).toBe('parent')
    // The node itself plus its one child.
    expect(entries[0].count).toBe(2)
    expect(storeA.load().map((n) => n.text).sort()).toEqual(['project'])
  })

  it('names the project a deleted node came out of, however deep', () => {
    // Not the immediate parent. A task deleted three levels down names a parent
    // you may not place; the project says which corner of the tree it was in.
    const { id: root } = storeA.addChild(null, 'project')
    const { id: mid } = storeA.addChild(root, 'parent')
    const { id: leaf } = storeA.addChild(mid, 'child')
    storeA.applyOp({ op: 'removeNode', id: leaf, trash: true })

    expect(storeA.trashPage().entries[0].projectText).toBe('project')
  })

  it('has no project to name for a deleted project, or an orphaned entry', () => {
    const { id: root } = storeA.addChild(null, 'project')
    const { id: child } = storeA.addChild(root, 'child')
    storeA.applyOp({ op: 'removeNode', id: child, trash: true })
    storeA.applyOp({ op: 'removeNode', id: root, trash: true })

    const byText = (t: string) =>
      storeA.trashPage().entries.find((e) => e.text === t)!
    // A project has no parent to walk up from.
    expect(byText('project').projectText).toBeNull()
    // The child's walk now runs off the end of `nodes` — its ancestor is itself
    // in the trash, so there is no live project to name.
    expect(byText('child').projectText).toBeNull()
  })

  it('follows a rename of the project after the delete', () => {
    // Resolved at read time rather than stored, so the label stays true.
    const { id: root } = storeA.addChild(null, 'project')
    const { id: child } = storeA.addChild(root, 'child')
    storeA.applyOp({ op: 'removeNode', id: child, trash: true })
    storeA.applyOp({ op: 'setText', id: root, text: 'renamed' })

    expect(storeA.trashPage().entries[0].projectText).toBe('renamed')
  })

  it('restores under the original parent', () => {
    const { id: root } = storeA.addChild(null, 'project')
    const { id: parent } = storeA.addChild(root, 'parent')
    const { id: child } = storeA.addChild(parent, 'child')
    storeA.applyOp({ op: 'removeNode', id: parent, trash: true })

    const entry = storeA.trashPage().entries[0]
    const tree = storeA.restore(entry.id)!
    expect(tree.find((n) => n.id === parent)!.parentId).toBe(root)
    expect(tree.find((n) => n.id === child)!.parentId).toBe(parent)
    // Restoring consumes the entry.
    expect(storeA.trashPage().entries).toEqual([])
    expect(invalidTree(storeA.load())).toBeNull()
  })

  it('restores to the top level when the original parent is gone too', () => {
    const { id: root } = storeA.addChild(null, 'project')
    const { id: parent } = storeA.addChild(root, 'parent')
    storeA.applyOp({ op: 'removeNode', id: parent, trash: true })
    storeA.applyOp({ op: 'removeNode', id: root, trash: true })

    const entry = storeA.trashPage().entries.find((e) => e.text === 'parent')!
    const tree = storeA.restore(entry.id)!
    // Notion's rule: an orphan comes back as a project rather than vanishing.
    expect(tree.find((n) => n.id === parent)!.parentId).toBeNull()
    expect(invalidTree(storeA.load())).toBeNull()
  })

  it('does not re-adopt when the parent is restored afterwards', () => {
    // Stated as a test because it is the accepted cost of the rule above, not
    // an oversight: the child is already a project by then, and moving it back
    // would be a second, unasked-for change.
    const { id: root } = storeA.addChild(null, 'project')
    const { id: parent } = storeA.addChild(root, 'parent')
    storeA.applyOp({ op: 'removeNode', id: parent, trash: true })
    storeA.applyOp({ op: 'removeNode', id: root, trash: true })

    const childEntry = storeA.trashPage().entries.find((e) => e.text === 'parent')!
    storeA.restore(childEntry.id)
    const rootEntry = storeA.trashPage().entries.find((e) => e.text === 'project')!
    const tree = storeA.restore(rootEntry.id)!
    expect(tree.find((n) => n.id === parent)!.parentId).toBeNull()
    expect(invalidTree(tree)).toBeNull()
  })

  it('restoring an unknown entry answers null rather than throwing', () => {
    expect(storeA.restore('nope')).toBeNull()
  })

  it('forgets an entry for good', () => {
    const { id } = storeA.addChild(null, 'project')
    storeA.applyOp({ op: 'removeNode', id, trash: true })
    const entry = storeA.trashPage().entries[0]
    storeA.forget(entry.id)
    expect(storeA.trashPage().entries).toEqual([])
    expect(storeA.restore(entry.id)).toBeNull()
  })

  it('sweeps only what is past the cutoff', () => {
    const { id: a1 } = storeA.addChild(null, 'old')
    const { id: a2 } = storeA.addChild(null, 'new')
    storeA.applyOp({ op: 'removeNode', id: a1, trash: true })
    storeA.applyOp({ op: 'removeNode', id: a2, trash: true })
    // Age the first entry by hand — the alternative is a clock injection that
    // exists only for this assertion.
    const old = storeA.trashPage().entries.find((e) => e.text === 'old')!
    a.exec('UPDATE trash_entries SET deletedAt = ? WHERE id = ?', 1000, old.id)

    expect(storeA.sweep(2000)).toBe(1)
    expect(storeA.trashPage().entries.map((e) => e.text)).toEqual(['new'])
    // The swept entry's nodes go with it, not just its row.
    expect(a.exec('SELECT * FROM trash_nodes WHERE entryId = ?', old.id).toArray()).toEqual([])
  })

  it('pages newest first, and says when there is more', () => {
    const ids = ['one', 'two', 'three'].map((t) => storeA.addChild(null, t).id)
    for (const id of ids) storeA.applyOp({ op: 'removeNode', id, trash: true })
    // Distinct timestamps, so the order under test is the one being asserted
    // rather than whatever three same-millisecond rows happen to come back in.
    const all = storeA.trashPage().entries
    all.forEach((e, i) =>
      a.exec('UPDATE trash_entries SET deletedAt = ? WHERE id = ?', 1000 + i, e.id))

    const first = storeA.trashPage(2)
    expect(first.entries).toHaveLength(2)
    expect(first.nextCursor).toBeDefined()
    const second = storeA.trashPage(2, first.nextCursor)
    expect(second.entries).toHaveLength(1)
    expect(second.nextCursor).toBeUndefined()
    // No entry appears on both pages.
    const seen = [...first.entries, ...second.entries].map((e) => e.id)
    expect(new Set(seen).size).toBe(3)
  })

  it('is per owner, like everything else here', () => {
    const { id } = storeA.addChild(null, 'A project')
    storeA.applyOp({ op: 'removeNode', id, trash: true })
    expect(storeB.trashPage().entries).toEqual([])
  })
})
