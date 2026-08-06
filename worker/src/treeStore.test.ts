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
