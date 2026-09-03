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
