import { describe, expect, it } from 'vitest'
import { applyOp, parseOp, reorderPinsOps, OP_KINDS, type Op } from './ops'
import {
  adoptFollowing,
  byId,
  childrenOf,
  indent,
  insertAtDepth,
  moveNode,
  outdent,
  pinnedItems,
  reconcileDone,
  removeNode,
  setDone,
  setPinOrder,
  setPinned,
  setText,
  toggleCollapsed,
  type Tree,
} from './tree'

/**
 *  taxes
 *    gather -> g1 (done) g2
 *    forms  -> p1 p2
 *  flat
 *    f1 f2
 */
function fixture(): Tree {
  const spec: Array<[string, string | null, string, boolean]> = [
    ['taxes', null, 'File the tax return', false],
    ['gather', 'taxes', 'Gather documents', false],
    ['g1', 'gather', "Find last year's return", true],
    ['g2', 'gather', 'Download bank CSV', false],
    ['forms', 'taxes', 'Fill in the forms', false],
    ['p1', 'forms', 'Page 1', false],
    ['p2', 'forms', 'Page 2', false],
    ['flat', null, 'Sort out the flat', false],
    ['f1', 'flat', 'Bins', false],
    ['f2', 'flat', 'Hoover', false],
  ]
  const order = new Map<string | null, number>()
  return spec.map(([id, parentId, text, done]) => {
    const o = order.get(parentId) ?? 0
    order.set(parentId, o + 1)
    return { id, parentId, text, done, order: o, collapsed: false, createdAt: 0 }
  })
}

const ids = (tree: Tree, parentId: string | null) => childrenOf(tree, parentId).map((n) => n.id)

/**
 * The property the whole scheme rests on: applying an op must land on exactly
 * what calling the underlying pure function does. Client and server both go
 * through applyOp, so if this drifts the two sides silently disagree.
 */
describe('applyOp matches the pure op it names', () => {
  it('setText', () => {
    const t = fixture()
    expect(applyOp(t, { op: 'setText', id: 'g2', text: 'Bank CSVs' }).tree).toEqual(
      setText(t, 'g2', 'Bank CSVs'),
    )
  })

  it('setDone, and passes back the ancestors that flipped', () => {
    const t = fixture()
    const direct = setDone(t, 'g2', true)
    const viaOp = applyOp(t, { op: 'setDone', id: 'g2', done: true })
    expect(viaOp.tree).toEqual(direct.tree)
    // g1 was already done, so finishing g2 completes gather.
    expect(viaOp.completed).toEqual(direct.completed)
    expect(viaOp.completed).toContain('gather')
  })

  it('removeNode', () => {
    const t = fixture()
    expect(applyOp(t, { op: 'removeNode', id: 'gather' }).tree).toEqual(
      reconcileDone(removeNode(t, 'gather')),
    )
  })

  it('moveNode', () => {
    const t = fixture()
    expect(applyOp(t, { op: 'moveNode', id: 'g1', parentId: 'forms', index: 1 }).tree).toEqual(
      reconcileDone(moveNode(t, 'g1', 'forms', 1)),
    )
  })

  it('indent', () => {
    const t = fixture()
    expect(applyOp(t, { op: 'indent', id: 'g2' }).tree).toEqual(reconcileDone(indent(t, 'g2')))
  })

  it('outdent', () => {
    const t = fixture()
    expect(applyOp(t, { op: 'outdent', id: 'g2' }).tree).toEqual(reconcileDone(outdent(t, 'g2')))
  })

  it('adoptFollowing', () => {
    const t = fixture()
    expect(applyOp(t, { op: 'adoptFollowing', id: 'gather' }).tree).toEqual(
      reconcileDone(adoptFollowing(t, 'gather')),
    )
  })

  it('insertAtDepth', () => {
    const t = fixture()
    const op: Op = {
      op: 'insertAtDepth',
      id: 'f1',
      anchorId: 'p1',
      depth: 1,
      side: 'after',
      scope: 'taxes',
    }
    expect(applyOp(t, op).tree).toEqual(
      reconcileDone(insertAtDepth(t, 'f1', 'p1', 1, 'after', 'taxes')),
    )
  })

  it('toggleCollapsed', () => {
    const t = fixture()
    expect(applyOp(t, { op: 'toggleCollapsed', id: 'forms' }).tree).toEqual(toggleCollapsed(t, 'forms'))
  })

  it('setPinned', () => {
    const t = fixture()
    expect(applyOp(t, { op: 'setPinned', id: 'flat', pinned: true }).tree).toEqual(
      setPinned(t, 'flat', true),
    )
  })

  it('setPinOrder', () => {
    const t = fixture()
    expect(applyOp(t, { op: 'setPinOrder', id: 'flat', order: 2 }).tree).toEqual(
      setPinOrder(t, 'flat', 2),
    )
  })

  it('markOpened stores the timestamp the op carried, not the clock', () => {
    const t = fixture()
    const at = 1_700_000_000_000
    const next = applyOp(t, { op: 'markOpened', id: 'flat', at }).tree
    expect(byId(next, 'flat')?.lastOpenedAt).toBe(at)
  })
})

/**
 * Creation is where client and server would drift: both would otherwise mint
 * their own ids and read their own clocks. The op carries both so the two sides
 * produce the same node.
 */
describe('creation ops are deterministic', () => {
  it('addChild uses the id and timestamp from the op', () => {
    const t = fixture()
    const op: Op = { op: 'addChild', id: 'fixed-id', parentId: 'flat', text: 'Mop', at: 12345 }
    const next = applyOp(t, op).tree
    const made = byId(next, 'fixed-id')
    expect(made).toBeDefined()
    expect(made?.text).toBe('Mop')
    expect(made?.parentId).toBe('flat')
    expect(made?.createdAt).toBe(12345)
  })

  it('two machines applying the same addChild get identical trees', () => {
    const op: Op = { op: 'addChild', id: 'same', parentId: 'flat', text: 'Mop', at: 999 }
    // The client applies it to its copy; the server applies it to its own.
    expect(applyOp(fixture(), op).tree).toEqual(applyOp(fixture(), op).tree)
  })

  it('the same addChild applied twice makes two nodes, not one', () => {
    // Deterministic is not idempotent, and the test above only shows the
    // first. The graft appends without checking whether the id is already
    // present, so a replay lands a second node under the same id — a tree
    // where `byId` is ambiguous and one of the pair cannot be reached.
    //
    // Pinned because the sending side has to know it: a queue that re-sends
    // an op the server already stored corrupts the tree rather than wasting a
    // round-trip. See `removeHead` in `AnsaSync/OpQueue.swift`.
    const op: Op = { op: 'addChild', id: 'dup', parentId: 'flat', text: 'Mop', at: 999 }
    const once = applyOp(fixture(), op).tree
    const twice = applyOp(once, op).tree
    expect(once.filter((n) => n.id === 'dup')).toHaveLength(1)
    expect(twice.filter((n) => n.id === 'dup')).toHaveLength(2)
  })

  it('addSubtree takes its ids depth-first, in the order given', () => {
    const t = fixture()
    const op: Op = {
      op: 'addSubtree',
      ids: ['a', 'b', 'c'],
      parentId: 'flat',
      nodes: [{ text: 'Kitchen', children: [{ text: 'Sink' }, { text: 'Oven' }] }],
      at: 500,
    }
    const next = applyOp(t, op).tree
    expect(byId(next, 'a')?.text).toBe('Kitchen')
    expect(byId(next, 'b')?.text).toBe('Sink')
    expect(byId(next, 'c')?.text).toBe('Oven')
    expect(byId(next, 'b')?.parentId).toBe('a')
    expect(byId(next, 'c')?.parentId).toBe('a')
  })

  it('mints an id when the op runs past the ids it was given', () => {
    const t = fixture()
    const op: Op = {
      op: 'addSubtree',
      ids: ['only-one'],
      parentId: 'flat',
      nodes: [{ text: 'A' }, { text: 'B' }],
      at: 0,
    }
    const next = applyOp(t, op).tree
    expect(byId(next, 'only-one')?.text).toBe('A')
    // The second node still lands, under a minted id rather than throwing.
    expect(childrenOf(next, 'flat').map((n) => n.text)).toEqual(['Bins', 'Hoover', 'A', 'B'])
  })
})

/**
 * A queued op can reach the server after the tree has moved on — the node it
 * names may have been deleted by someone else in the meantime. That has to be a
 * no-op, not a crash, or one racing delete would wedge the client.
 */
describe('applyOp is total', () => {
  const unknown: Op[] = [
    { op: 'setText', id: 'ghost', text: 'x' },
    { op: 'setDone', id: 'ghost', done: true },
    { op: 'removeNode', id: 'ghost' },
    { op: 'moveNode', id: 'ghost', parentId: 'flat', index: 0 },
    { op: 'indent', id: 'ghost' },
    { op: 'outdent', id: 'ghost' },
    { op: 'adoptFollowing', id: 'ghost' },
    { op: 'insertAtDepth', id: 'ghost', anchorId: 'p1', depth: 0, side: 'after', scope: null },
    { op: 'toggleCollapsed', id: 'ghost' },
    { op: 'setPinned', id: 'ghost', pinned: true },
    { op: 'setPinOrder', id: 'ghost', order: 0 },
    { op: 'markOpened', id: 'ghost', at: 1 },
  ]

  for (const op of unknown) {
    it(`${op.op} against a missing node leaves the tree alone`, () => {
      const t = fixture()
      expect(() => applyOp(t, op)).not.toThrow()
      expect(applyOp(t, op).tree).toEqual(t)
    })
  }

  it('an op naming a missing anchor is also survivable', () => {
    const t = fixture()
    const op: Op = { op: 'insertAtDepth', id: 'f1', anchorId: 'ghost', depth: 0, side: 'after', scope: null }
    expect(() => applyOp(t, op)).not.toThrow()
  })
})

/**
 * The regression this whole change exists for. Two clients edit different
 * branches at the same time; the server replays both ops against its own tree.
 * Under the old whole-tree write the second save would have erased the first.
 */
describe('concurrent edits on unrelated branches both survive', () => {
  it('a rename and an add do not clobber each other', () => {
    const server = fixture()
    // Both clients start from the same tree and act without seeing each other.
    const fromApp: Op = { op: 'setText', id: 'g2', text: 'Bank statements' }
    const fromMcp: Op = { op: 'addChild', id: 'new', parentId: 'flat', text: 'Wash up', at: 7 }

    const afterBoth = applyOp(applyOp(server, fromApp).tree, fromMcp).tree

    expect(byId(afterBoth, 'g2')?.text).toBe('Bank statements')
    expect(byId(afterBoth, 'new')?.text).toBe('Wash up')
  })

  it('lands the same way whichever order the two ops arrive in', () => {
    const a: Op = { op: 'setText', id: 'g2', text: 'Bank statements' }
    const b: Op = { op: 'setText', id: 'f1', text: 'Take the bins out' }

    const ab = applyOp(applyOp(fixture(), a).tree, b).tree
    const ba = applyOp(applyOp(fixture(), b).tree, a).tree

    expect(ab).toEqual(ba)
  })

  it('a delete on one branch leaves a concurrent move on another intact', () => {
    const server = fixture()
    const deleteBranch: Op = { op: 'removeNode', id: 'gather' }
    const moveElsewhere: Op = { op: 'moveNode', id: 'f2', parentId: 'flat', index: 0 }

    const next = applyOp(applyOp(server, deleteBranch).tree, moveElsewhere).tree

    expect(byId(next, 'gather')).toBeUndefined()
    expect(ids(next, 'flat')).toEqual(['f2', 'f1'])
  })
})

describe('parseOp', () => {
  it('accepts every op kind the union defines', () => {
    // Guards against adding a case to Op and forgetting the validator, which
    // would 400 a real edit.
    const samples: Record<string, unknown> = {
      addChild: { op: 'addChild', id: 'a', parentId: null, text: 'x', at: 1 },
      addSubtree: { op: 'addSubtree', ids: ['a'], parentId: null, nodes: [{ text: 'x' }], at: 1 },
      setText: { op: 'setText', id: 'a', text: 'x' },
      setDone: { op: 'setDone', id: 'a', done: true },
      removeNode: { op: 'removeNode', id: 'a' },
      moveNode: { op: 'moveNode', id: 'a', parentId: null, index: 0 },
      indent: { op: 'indent', id: 'a' },
      outdent: { op: 'outdent', id: 'a' },
      adoptFollowing: { op: 'adoptFollowing', id: 'a' },
      insertAtDepth: { op: 'insertAtDepth', id: 'a', anchorId: 'b', depth: 0, side: 'after', scope: null },
      toggleCollapsed: { op: 'toggleCollapsed', id: 'a' },
      setPinned: { op: 'setPinned', id: 'a', pinned: true },
      setPinOrder: { op: 'setPinOrder', id: 'a', order: 0 },
      markOpened: { op: 'markOpened', id: 'a', at: 1 },
    }
    for (const kind of OP_KINDS) {
      expect(parseOp(samples[kind]), `${kind} should parse`).not.toHaveProperty('error')
    }
  })

  it('keeps a null parentId distinct from a missing one', () => {
    // null means "the root list" — it has to survive validation as a real value.
    const parsed = parseOp({ op: 'moveNode', id: 'a', parentId: null, index: 0 })
    expect(parsed).toEqual({ op: { op: 'moveNode', id: 'a', parentId: null, index: 0 } })
    expect(parseOp({ op: 'moveNode', id: 'a', index: 0 })).toHaveProperty('error')
  })

  it('rejects an unknown op name', () => {
    expect(parseOp({ op: 'drop-database', id: 'a' })).toHaveProperty('error')
  })

  it('rejects a non-object', () => {
    expect(parseOp(null)).toHaveProperty('error')
    expect(parseOp('setText')).toHaveProperty('error')
  })

  it('names the field that was wrong', () => {
    const bad = parseOp({ op: 'setDone', id: 'a', done: 'yes' })
    expect(bad).toHaveProperty('error')
    expect('error' in bad && bad.error).toContain('done')
  })

  it('rejects a malformed nested outline', () => {
    const bad = parseOp({ op: 'addSubtree', ids: ['a'], parentId: null, nodes: [{ nope: 1 }], at: 1 })
    expect(bad).toHaveProperty('error')
  })
})

/**
 * A Tree is every project the owner has, so an op has to reconcile the projects
 * it touched and leave the others alone — including one that is already wrong.
 * Sweeping everything would quietly "fix" the untouched project and hide that
 * the scope was never applied.
 */
describe('reconcile is scoped to the projects the op touched', () => {
  const twoProjects = (): Tree => [
    { id: 'a', parentId: null, text: 'A', done: false, order: 0, collapsed: false, createdAt: 0 },
    { id: 'a1', parentId: 'a', text: 'A1', done: true, order: 0, collapsed: false, createdAt: 0 },
    { id: 'a2', parentId: 'a', text: 'A2', done: false, order: 1, collapsed: false, createdAt: 0 },
    // Deliberately stale: every child is done but the parent says otherwise.
    { id: 'b', parentId: null, text: 'B', done: false, order: 1, collapsed: false, createdAt: 0 },
    { id: 'b1', parentId: 'b', text: 'B1', done: true, order: 0, collapsed: false, createdAt: 0 },
  ]

  it('reconciles the touched project', () => {
    const out = applyOp(twoProjects(), { op: 'removeNode', id: 'a2' }).tree
    expect(byId(out, 'a')!.done).toBe(true)
  })

  it('leaves an untouched project exactly as it found it', () => {
    const out = applyOp(twoProjects(), { op: 'removeNode', id: 'a2' }).tree
    expect(byId(out, 'b')!.done).toBe(false)
  })

  it('a cross-project move reconciles both ends', () => {
    const out = applyOp(twoProjects(), { op: 'moveNode', id: 'a2', parentId: 'b', index: 1 }).tree
    // 'a' lost its only unfinished child; 'b' gained one.
    expect(byId(out, 'a')!.done).toBe(true)
    expect(byId(out, 'b')!.done).toBe(false)
  })
})

describe('reorderPinsOps — dragging a pin on the shelf', () => {
  /** Pin ids in order, arranging them densely from 0. */
  const shelf = (tree: Tree, ...ids: string[]) =>
    tree.map((n) =>
      ids.includes(n.id) ? { ...n, pinned: true, pinOrder: ids.indexOf(n.id) } : n,
    )

  it('renumbers only what moved', () => {
    // A drag past one neighbour swaps two positions; every pin below is
    // untouched, so an op for it would be a write that changes nothing.
    const t = shelf(fixture(), 'taxes', 'g2', 'gather')
    expect(reorderPinsOps(t, 0, 1)).toEqual([
      { op: 'setPinOrder', id: 'g2', order: 0 },
      { op: 'setPinOrder', id: 'taxes', order: 1 },
    ])
  })

  it('arranges a shelf that was never dragged', () => {
    // Everything starts absent, so the first drag has to write a position for
    // every pin — that is what takes the list off the depth fallback.
    const t = fixture().map((n) =>
      ['taxes', 'g2'].includes(n.id) ? { ...n, pinned: true } : n,
    )
    expect(reorderPinsOps(t, 1, 0)).toEqual([
      { op: 'setPinOrder', id: 'g2', order: 0 },
      { op: 'setPinOrder', id: 'taxes', order: 1 },
    ])
  })

  it('is a no-op when the pin lands where it started', () => {
    const t = shelf(fixture(), 'taxes', 'g2')
    expect(reorderPinsOps(t, 0, 0)).toEqual([])
  })

  it('clamps a drop past the end', () => {
    const t = shelf(fixture(), 'taxes', 'g2', 'gather')
    expect(reorderPinsOps(t, 0, 99)).toEqual([
      { op: 'setPinOrder', id: 'g2', order: 0 },
      { op: 'setPinOrder', id: 'gather', order: 1 },
      { op: 'setPinOrder', id: 'taxes', order: 2 },
    ])
  })

  it('ignores a source index that is not on the shelf', () => {
    const t = shelf(fixture(), 'taxes')
    expect(reorderPinsOps(t, 5, 0)).toEqual([])
  })

  it('applies to the order the shelf then reads back', () => {
    // The ops and the sort have to agree, since one is derived from the other.
    const t = shelf(fixture(), 'taxes', 'g2', 'gather')
    const moved = reorderPinsOps(t, 2, 0).reduce((acc, op) => applyOp(acc, op).tree, t)
    expect(pinnedItems(moved).map((p) => p.node.id)).toEqual(['gather', 'taxes', 'g2'])
  })
})
