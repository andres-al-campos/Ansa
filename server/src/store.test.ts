/**
 * Ownership isolation.
 *
 * These tests exist because "the code looks right" is not evidence for this
 * particular property. A missing WHERE clause leaks one user's tree to another,
 * and nothing else in the suite would go red — the app would keep working
 * perfectly for a single user, which is exactly how this kind of bug ships.
 *
 * So they assert the negative directly: after B writes, A's tree is unchanged.
 * Against a real SQLite database rather than a fake, because the property under
 * test *is* the SQL.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from './store.ts'
import { roots } from '../../shared/tree.ts'

const A = 'user-a'
const B = 'user-b'

let dir: string
let store: Store

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ansa-store-'))
  store = new Store(join(dir, 'test.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

/** The text of every root ("project") in an owner's tree. */
const projects = (owner: string) =>
  roots(store.load(owner))
    .map((n) => n.text)
    .sort()

describe('reads are scoped to the owner', () => {
  it("one owner's tree doesn't include another's nodes", () => {
    store.addChild(A, null, 'A project')
    store.addChild(B, null, 'B project')
    expect(projects(A)).toEqual(['A project'])
    expect(projects(B)).toEqual(['B project'])
  })

  it('an owner with no rows gets an empty tree, not everyone else\'s', () => {
    store.addChild(A, null, 'A project')
    store.addChild(B, null, 'B project')
    expect(store.load('user-c')).toEqual([])
  })
})

describe('writes are scoped to the owner', () => {
  // The whole-table rewrite in `replace` starts with a DELETE. If that DELETE
  // isn't scoped, *any* write by anyone wipes every other account — so this is
  // the single most important assertion in the file.
  it("one owner's write leaves another's tree intact", () => {
    store.addChild(A, null, 'A project')
    const before = store.load(A)
    store.addChild(B, null, 'B project')
    store.addChild(B, null, 'B second')
    expect(store.load(A)).toEqual(before)
  })

  it('a full replaceAll only replaces that owner', () => {
    store.addChild(A, null, 'A project')
    const before = store.load(A)
    store.replaceAll(B, [
      { id: 'b1', parentId: null, text: 'only B', done: false, order: 0, collapsed: false, createdAt: 1 },
    ])
    expect(store.load(A)).toEqual(before)
    expect(projects(B)).toEqual(['only B'])
  })

  it('removing every node of one owner leaves the other untouched', () => {
    const { id } = store.addChild(A, null, 'A project')
    store.addChild(B, null, 'B project')
    store.remove(A, id)
    expect(store.load(A)).toEqual([])
    expect(projects(B)).toEqual(['B project'])
  })
})

describe("an owner can't reach across to another's nodes by id", () => {
  // Ops name node ids the caller chose, so a caller can name a node they don't
  // own. Isolation here comes from the filtered load — the id simply isn't in
  // the tree the pure op sees — rather than from a per-id check.
  it('renaming another owner\'s node does nothing', () => {
    const { id } = store.addChild(A, null, 'A project')
    store.addChild(B, null, 'B project')
    store.rename(B, id, 'renamed by B')
    expect(projects(A)).toEqual(['A project'])
  })

  it("deleting another owner's node does nothing", () => {
    const { id } = store.addChild(A, null, 'A project')
    store.addChild(B, null, 'B project')
    store.remove(B, id)
    expect(projects(A)).toEqual(['A project'])
  })

  it("checking off another owner's node does nothing", () => {
    const { id } = store.addChild(A, null, 'A task')
    store.addChild(B, null, 'B project')
    store.setDone(B, id, true)
    expect(store.load(A)[0]?.done).toBe(false)
  })

  // These three are about a subtler failure than a read leak. The pure tree
  // functions don't require a parent to exist, so pointing a write at a
  // stranger's node id used to *succeed*: B got a node whose parentId was a live
  // row in A's tree. Nothing leaked, but B's tree failed its own validator, and
  // A deleting that project would have cascade-deleted B's node.
  it("adding a child under another owner's node is refused", () => {
    const { id } = store.addChild(A, null, 'A project')
    expect(() => store.addChild(B, id, 'B nesting under A')).toThrow(/No such parent task/)
    expect(store.load(A)).toHaveLength(1)
    expect(store.load(B)).toEqual([])
  })

  it("grafting a subtree under another owner's node is refused", () => {
    const { id } = store.addChild(A, null, 'A project')
    expect(() => store.addSubtree(B, id, [{ text: 'B subtree' }])).toThrow(/No such parent task/)
    expect(store.load(B)).toEqual([])
  })

  it("moving one's own node under another owner's node is refused", () => {
    const a = store.addChild(A, null, 'A project')
    const b = store.addChild(B, null, 'B project')
    expect(() => store.move(B, b.id, a.id, 0)).toThrow(/No such parent task/)
    expect(store.load(B)[0]?.parentId).toBeNull()
  })

  it('an op naming another owner\'s node as parent is refused', () => {
    // The app's real write path is /api/ops, not the per-verb methods, so the
    // same reach-across has to be blocked there too.
    const { id } = store.addChild(A, null, 'A project')
    store.addChild(B, null, 'B project')
    expect(() =>
      store.applyOp(B, { op: 'addChild', parentId: id, text: 'via op', id: 'x1', at: 1 }),
    ).toThrow(/corrupt the tree/)
    expect(store.load(A)).toHaveLength(1)
    expect(store.load(B)).toHaveLength(1)
  })
})

describe('ids are unique across owners', () => {
  // Node ids are the table's primary key, so two owners generating the same id
  // would collide on insert. Generated ids make this vanishingly unlikely, but
  // the failure mode would be a write throwing rather than data mixing.
  it('two owners building trees in parallel both persist', () => {
    for (let i = 0; i < 20; i++) {
      store.addChild(A, null, `a${i}`)
      store.addChild(B, null, `b${i}`)
    }
    expect(store.load(A)).toHaveLength(20)
    expect(store.load(B)).toHaveLength(20)
  })
})
