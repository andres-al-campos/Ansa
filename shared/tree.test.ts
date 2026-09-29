import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_TEXT_LENGTH,
  addChild,
  addSubtree,
  newId,
  adoptFollowing,
  byId,
  childrenOf,
  depthAtGap,
  indent,
  insertAtDepth,
  isAncestor,
  invalidTree,
  isLeaf,
  leavesUnder,
  lineageOf,
  moveNode,
  moveRow,
  outdent,
  pinnedItems,
  progressOf,
  reconcileDone,
  removeNode,
  resumeScope,
  roots,
  setDone,
  subtreeOf,
  type Node,
  type Tree,
  fingerprint,
} from './tree'

/**
 *  taxes
 *    gather
 *      g1 (done)  g2  g3
 *    forms
 *      p1 -> p1a p1b
 *      p2 -> p2a, p2b -> p2b1 p2b2
 *  flat
 *    f1 f2
 */
function fixture(): Tree {
  const spec: Array<[string, string | null, string, boolean]> = [
    ['taxes', null, 'File the tax return', false],
    ['gather', 'taxes', 'Gather documents', false],
    ['g1', 'gather', "Find last year's return", true],
    ['g2', 'gather', 'Download bank CSV', false],
    ['g3', 'gather', 'Dig out the P60', false],
    ['forms', 'taxes', 'Fill the forms', false],
    ['p1', 'forms', 'Page 1', false],
    ['p1a', 'p1', 'Name and address', false],
    ['p1b', 'p1', 'NI number', false],
    ['p2', 'forms', 'Page 2', false],
    ['p2a', 'p2', 'Salary', false],
    ['p2b', 'p2', 'Freelance income', false],
    ['p2b1', 'p2b', 'Total the invoices', false],
    ['p2b2', 'p2b', 'Convert the USD ones', false],
    ['flat', null, 'Sort out the flat', false],
    ['f1', 'flat', 'Email the landlord', false],
    ['f2', 'flat', 'Book a carpet clean', false],
  ]
  return spec.map(([id, parentId, text, done], i) => ({
    id,
    parentId,
    text,
    done,
    order: i,
    collapsed: false,
    createdAt: 0,
  }))
}

describe('structure', () => {
  it('finds roots and direct children', () => {
    const t = fixture()
    expect(childrenOf(t, null).map((n) => n.id)).toEqual(['taxes', 'flat'])
    expect(childrenOf(t, 'forms').map((n) => n.id)).toEqual(['p1', 'p2'])
  })

  it('knows a leaf from a parent', () => {
    const t = fixture()
    expect(isLeaf(t, 'p1a')).toBe(true)
    expect(isLeaf(t, 'p2b')).toBe(false)
  })

  it('walks lineage root-first', () => {
    expect(lineageOf(fixture(), 'p2b1').map((n) => n.id)).toEqual(['taxes', 'forms', 'p2', 'p2b', 'p2b1'])
  })
})

describe('leavesUnder — the leaf filter', () => {
  it('flattens the whole subtree, not just direct children', () => {
    // p2b1/p2b2 sit 3 levels under `forms` and must still show.
    expect(leavesUnder(fixture(), 'forms').map((n) => n.id)).toEqual(['p1a', 'p1b', 'p2a', 'p2b1', 'p2b2'])
  })

  it('excludes intermediate parents', () => {
    expect(leavesUnder(fixture(), 'forms').map((n) => n.id)).not.toContain('p2b')
  })

  it('scopes to the given node only', () => {
    expect(leavesUnder(fixture(), 'flat').map((n) => n.id)).toEqual(['f1', 'f2'])
  })
})

describe('progress is leaf-weighted', () => {
  it('a grandchild completing moves the grandparent', () => {
    // The bug this guards: counting direct children would leave `taxes` at 0%,
    // because `gather` is not itself done.
    const t = fixture()
    const before = progressOf(t, 'taxes')
    const after = progressOf(setDone(t, 'g2', true).tree, 'taxes')
    expect(after.done).toBeGreaterThan(before.done)
    expect(after.pct).toBeGreaterThan(before.pct)
  })

  it('counts every leaf in the subtree', () => {
    // gather 3 + forms 5 = 8 leaves under taxes, one already done.
    const p = progressOf(fixture(), 'taxes')
    expect(p.total).toBe(8)
    expect(p.done).toBe(1)
    expect(p.pct).toBe(13)
  })

  it('reaches exactly 100 when the subtree is finished', () => {
    let t = fixture()
    for (const id of ['p1a', 'p1b', 'p2a', 'p2b1', 'p2b2']) t = setDone(t, id, true).tree
    expect(progressOf(t, 'forms')).toEqual({ done: 5, total: 5, pct: 100 })
  })

  it('decomposing a leaf moves the denominator, it does not reset the level', () => {
    // The worry that nearly cut progress bars: splitting work shouldn't tank
    // the number. 1/3 -> 1/5 is a dip, not a collapse to zero.
    const t = fixture()
    const before = progressOf(setDone(t, 'g2', true).tree, 'gather')
    let after = setDone(t, 'g2', true).tree
    after = addChild(after, 'g3', 'sub a').tree
    after = addChild(after, 'g3', 'sub b').tree
    const p = progressOf(after, 'gather')
    expect(before.pct).toBe(67) // g1 + g2 of 3
    expect(p.pct).toBe(50) // g1 + g2 of 4 (g3 became a parent of 2)
  })
})

describe('setDone cascades', () => {
  it('completes the parent when the last child lands, and reports it', () => {
    const t = fixture()
    const first = setDone(t, 'p1a', true)
    expect(first.completed).toEqual([])
    const second = setDone(first.tree, 'p1b', true)
    expect(second.completed).toContain('p1')
  })

  it('climbs several levels at once', () => {
    let t = fixture()
    t = setDone(t, 'p1a', true).tree
    t = setDone(t, 'p1b', true).tree
    t = setDone(t, 'p2a', true).tree
    t = setDone(t, 'p2b1', true).tree
    const last = setDone(t, 'p2b2', true)
    // p2b, then p2, then forms all complete off one tick.
    expect(last.completed).toEqual(['p2b', 'p2', 'forms'])
  })

  it('ticking a parent completes its whole subtree', () => {
    const { tree } = setDone(fixture(), 'forms', true)
    for (const id of ['p1', 'p1a', 'p1b', 'p2', 'p2a', 'p2b', 'p2b1', 'p2b2']) {
      expect(tree.find((n) => n.id === id)!.done, id).toBe(true)
    }
  })

  it('unticking a descendant re-opens every ancestor', () => {
    let t = setDone(fixture(), 'taxes', true).tree
    expect(t.find((n) => n.id === 'taxes')!.done).toBe(true)
    t = setDone(t, 'p2b2', false).tree
    for (const id of ['p2b', 'p2', 'forms', 'taxes']) {
      expect(t.find((n) => n.id === id)!.done, id).toBe(false)
    }
  })

  it('does not mutate the tree it was given', () => {
    const t = fixture()
    setDone(t, 'p1a', true)
    expect(t.find((n) => n.id === 'p1a')!.done).toBe(false)
  })
})

describe('editing', () => {
  it('removing a node takes its subtree with it', () => {
    const t = removeNode(fixture(), 'p2')
    for (const id of ['p2', 'p2a', 'p2b', 'p2b1', 'p2b2']) {
      expect(t.find((n) => n.id === id), id).toBeUndefined()
    }
    expect(t.find((n) => n.id === 'p1')).toBeDefined()
  })

  it('a new child lands last among its siblings', () => {
    const { tree, id } = addChild(fixture(), 'gather', 'Find the P45')
    expect(childrenOf(tree, 'gather').map((n) => n.id)).toEqual(['g1', 'g2', 'g3', id])
  })

  it('spots ancestors so a move cannot make a cycle', () => {
    const t = fixture()
    expect(isAncestor(t, 'forms', 'p2b1')).toBe(true)
    expect(isAncestor(t, 'p2b1', 'forms')).toBe(false)
  })
})

describe('addSubtree', () => {
  const spec = [
    { text: 'Gather', children: [{ text: 'Find the P45' }, { text: 'Download CSV' }] },
    { text: 'Submit' },
  ]

  it('grafts a nested subtree under a parent in one call', () => {
    const { tree, ids } = addSubtree(fixture(), 'taxes', spec)
    // Two new top-level children plus two grandchildren = 4 ids.
    expect(ids).toHaveLength(4)
    const [gather, find, download, submit] = ids
    // The spec order is preserved, depth-first: Gather, its two kids, then Submit.
    expect(tree.find((n) => n.id === gather)?.text).toBe('Gather')
    expect(tree.find((n) => n.id === submit)?.text).toBe('Submit')
    expect(childrenOf(tree, gather).map((n) => n.id)).toEqual([find, download])
    // Grafted after the existing children of taxes (gather, forms).
    expect(childrenOf(tree, 'taxes').map((n) => n.text)).toEqual([
      'Gather documents',
      'Fill the forms',
      'Gather',
      'Submit',
    ])
  })

  it('creates a brand-new project when parentId is null', () => {
    const before = roots(fixture()).length
    const { tree, ids } = addSubtree(fixture(), null, [
      { text: 'Plan the trip', children: [{ text: 'Book flights' }] },
    ])
    expect(roots(tree)).toHaveLength(before + 1)
    // The first id is the new root — the project id a caller would open.
    const [project, flights] = ids
    expect(tree.find((n) => n.id === project)?.parentId).toBeNull()
    expect(tree.find((n) => n.id === flights)?.parentId).toBe(project)
  })

  it('gives every grafted node a distinct id', () => {
    const { ids } = addSubtree(fixture(), 'taxes', spec)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('siblings within the graft keep a dense 0..n order', () => {
    const { tree, ids } = addSubtree(fixture(), null, spec)
    const kids = childrenOf(tree, ids[0]) // children of "Gather"
    expect(kids.map((n) => n.order)).toEqual([0, 1])
  })

  it('leaves the original tree untouched', () => {
    const t = fixture()
    const copy = JSON.parse(JSON.stringify(t))
    addSubtree(t, 'taxes', spec)
    expect(t).toEqual(copy)
  })

  it('a deep spec round-trips through subtreeOf', () => {
    const { tree, ids } = addSubtree(fixture(), null, [
      { text: 'A', children: [{ text: 'B', children: [{ text: 'C' }] }] },
    ])
    expect(subtreeOf(tree, ids[0]).map((n) => n.text)).toEqual(['B', 'C'])
  })
})

describe('indent / outdent', () => {
  it('indent tucks a node under its preceding sibling, last', () => {
    // g2 slides under g1.
    const t = indent(fixture(), 'g2')
    expect(childrenOf(t, 'gather').map((n) => n.id)).toEqual(['g1', 'g3'])
    expect(childrenOf(t, 'g1').map((n) => n.id)).toEqual(['g2'])
  })

  it('indent is a no-op for a first child', () => {
    const t = fixture()
    expect(indent(t, 'g1')).toEqual(t)
    // p1 is the first child of forms.
    expect(indent(t, 'p1')).toEqual(t)
  })

  it('outdent pops a node up beside its old parent, right after it', () => {
    // p1a leaves p1 to sit under forms, between p1 and p2.
    const t = outdent(fixture(), 'p1a')
    expect(t.find((n) => n.id === 'p1a')!.parentId).toBe('forms')
    expect(childrenOf(t, 'forms').map((n) => n.id)).toEqual(['p1', 'p1a', 'p2'])
    expect(childrenOf(t, 'p1').map((n) => n.id)).toEqual(['p1b'])
  })

  it('outdent is a no-op at the root', () => {
    const t = fixture()
    expect(outdent(t, 'taxes')).toEqual(t)
  })

  it('indent then outdent round-trips the parent', () => {
    let t = fixture()
    t = indent(t, 'g2') // g2 under g1
    t = outdent(t, 'g2') // back beside g1 under gather
    expect(t.find((n) => n.id === 'g2')!.parentId).toBe('gather')
    expect(childrenOf(t, 'gather').map((n) => n.id)).toEqual(['g1', 'g2', 'g3'])
  })
})

describe('adoptFollowing', () => {
  it('nests every following sibling under the node, in order', () => {
    // g1 pulls its two following siblings (g2, g3) in as its children.
    const t = adoptFollowing(fixture(), 'g1')
    expect(childrenOf(t, 'gather').map((n) => n.id)).toEqual(['g1'])
    expect(childrenOf(t, 'g1').map((n) => n.id)).toEqual(['g2', 'g3'])
  })

  it('appends after any existing children', () => {
    // p1 already has p1a, p1b; adopting pulls p2 in after them.
    const t = adoptFollowing(fixture(), 'p1')
    expect(childrenOf(t, 'forms').map((n) => n.id)).toEqual(['p1'])
    expect(childrenOf(t, 'p1').map((n) => n.id)).toEqual(['p1a', 'p1b', 'p2'])
  })

  it('moves whole subtrees, keeping their descendants', () => {
    const t = adoptFollowing(fixture(), 'p1')
    // p2's own children ride along.
    expect(childrenOf(t, 'p2').map((n) => n.id)).toEqual(['p2a', 'p2b'])
  })

  it('is a no-op for the last sibling', () => {
    const t = fixture()
    expect(adoptFollowing(t, 'g3')).toEqual(t)
  })

  it('is a no-op for an unknown id', () => {
    const t = fixture()
    expect(adoptFollowing(t, 'nope')).toEqual(t)
  })
})

describe('moveNode', () => {
  it('reorders within a parent, and orders stay dense 0..n-1', () => {
    // g1 -> end of gather.
    const t = moveNode(fixture(), 'g1', 'gather', 3)
    expect(childrenOf(t, 'gather').map((n) => n.id)).toEqual(['g2', 'g3', 'g1'])
    expect(childrenOf(t, 'gather').map((n) => n.order)).toEqual([0, 1, 2])
  })

  it('moves across parents, closing the source gap and renumbering both', () => {
    // Send f1 into gather at the front.
    const t = moveNode(fixture(), 'f1', 'gather', 0)
    expect(childrenOf(t, 'gather').map((n) => n.id)).toEqual(['f1', 'g1', 'g2', 'g3'])
    expect(childrenOf(t, 'gather').map((n) => n.order)).toEqual([0, 1, 2, 3])
    expect(childrenOf(t, 'flat').map((n) => n.id)).toEqual(['f2'])
    expect(childrenOf(t, 'flat').map((n) => n.order)).toEqual([0])
  })

  it('nests a node under a leaf, making it a parent', () => {
    // Drop g2 onto p1a (a leaf); p1a now has a child.
    const t = moveNode(fixture(), 'g2', 'p1a', 0)
    expect(t.find((n) => n.id === 'g2')!.parentId).toBe('p1a')
    expect(childrenOf(t, 'p1a').map((n) => n.id)).toEqual(['g2'])
    expect(isLeaf(t, 'p1a')).toBe(false)
  })

  it('can promote a node to a new root', () => {
    const t = moveNode(fixture(), 'p2b', null, 1)
    expect(t.find((n) => n.id === 'p2b')!.parentId).toBe(null)
    expect(roots(t).map((n) => n.id)).toEqual(['taxes', 'p2b', 'flat'])
  })

  it('refuses to drop a node into its own descendant (would cycle)', () => {
    const t = fixture()
    // forms into p2b1, which sits under forms — must be a no-op.
    expect(moveNode(t, 'forms', 'p2b1', 0)).toEqual(t)
    // and into itself.
    expect(moveNode(t, 'forms', 'forms', 0)).toEqual(t)
  })

  it('clamps an out-of-range index', () => {
    const t = moveNode(fixture(), 'f1', 'gather', 99)
    expect(childrenOf(t, 'gather').map((n) => n.id)).toEqual(['g1', 'g2', 'g3', 'f1'])
  })

  it('same-parent move to the same slot is a no-op in effect', () => {
    const t = fixture()
    // g2 is at index 1 among gather's children; moving it to index 1 keeps order.
    expect(childrenOf(moveNode(t, 'g2', 'gather', 1), 'gather').map((n) => n.id)).toEqual(['g1', 'g2', 'g3'])
  })
})

// The drop indicator's X → indent level. Guides sit at GUIDE_X0 + d*INDENT;
// use the same numbers the UI does so the maths is exercised end to end.
const GUIDE_X0 = 32
const INDENT = 24
const guideX = (d: number) => GUIDE_X0 + d * INDENT

describe('depthAtGap', () => {
  it('rounds the pointer X to the nearest indent stop', () => {
    // Gap between a depth-2 row above and a depth-0 row below.
    expect(depthAtGap(guideX(0), 2, 0, GUIDE_X0, INDENT)).toBe(0)
    expect(depthAtGap(guideX(1), 2, 0, GUIDE_X0, INDENT)).toBe(1)
    expect(depthAtGap(guideX(2), 2, 0, GUIDE_X0, INDENT)).toBe(2)
  })

  it('lets you nest one level under the row above, no deeper', () => {
    // Above is depth 1, so the deepest legal drop is depth 2.
    expect(depthAtGap(guideX(9), 1, 0, GUIDE_X0, INDENT)).toBe(2)
  })

  it('will not go shallower than the top level', () => {
    // Dragging far left lands at the root, not at a negative depth. The row
    // below used to be the floor instead; see the outdent case below for why
    // that floor was wrong.
    expect(depthAtGap(GUIDE_X0 - 200, 2, 1, GUIDE_X0, INDENT)).toBe(0)
  })

  it('lets a row outdent in place, past the row below it', () => {
    // The gap under a depth-1 row, with another depth-1 row below it. Clamping
    // to the row below made depth 0 unreachable here — and in every gap inside
    // the parent — so promoting a child to top level meant dragging it past the
    // end of its parent's whole subtree to find the one gap with nothing below.
    //
    // Nothing is stranded by allowing it: the row below keeps its own parent,
    // and the dragged row lands after that parent, which is exactly where
    // Shift-Tab puts it. The clamp only ever protected the indicator's drawing.
    expect(depthAtGap(guideX(0), 1, 1, GUIDE_X0, INDENT)).toBe(0)

    // The row above still bounds how deep you can go — that end is unchanged.
    expect(depthAtGap(guideX(9), 1, 1, GUIDE_X0, INDENT)).toBe(2)
  })

  it('at the top of the list (no row above) cannot nest', () => {
    // maxD is the first row's own depth; here the first row is depth 0.
    expect(depthAtGap(guideX(5), null, 0, GUIDE_X0, INDENT)).toBe(0)
  })

  it('at the end of the list (no row below) can drop to depth 0', () => {
    expect(depthAtGap(GUIDE_X0 - 200, 2, null, GUIDE_X0, INDENT)).toBe(0)
    expect(depthAtGap(guideX(3), 2, null, GUIDE_X0, INDENT)).toBe(3)
  })
})

describe('insertAtDepth', () => {
  // Scope is `taxes`; anchor `p2b1` gives the deepest chain:
  // [forms(0), p2(1), p2b(2), p2b1(3)]. Dragging f1 after p2b1 at each depth
  // should land it beside a different ancestor on that path.
  it('deepest depth nests under the anchor itself', () => {
    const t = insertAtDepth(fixture(), 'f1', 'p2b1', 4, 'after', 'taxes')
    expect(childrenOf(t, 'p2b1').map((n) => n.id)).toEqual(['f1'])
  })

  it('one level up sits beside the anchor among its siblings', () => {
    const t = insertAtDepth(fixture(), 'f1', 'p2b1', 3, 'after', 'taxes')
    expect(childrenOf(t, 'p2b').map((n) => n.id)).toEqual(['p2b1', 'f1', 'p2b2'])
  })

  it('an intermediate depth lands after the branch on the path', () => {
    const t = insertAtDepth(fixture(), 'f1', 'p2b1', 1, 'after', 'taxes')
    expect(childrenOf(t, 'forms').map((n) => n.id)).toEqual(['p1', 'p2', 'f1'])
  })

  it('depth 0 lands among the scope\'s own children', () => {
    const t = insertAtDepth(fixture(), 'f1', 'p2b1', 0, 'after', 'taxes')
    expect(childrenOf(t, 'taxes').map((n) => n.id)).toEqual(['gather', 'forms', 'f1'])
  })

  it("'before' inserts on the near side of the row on the path", () => {
    // Anchor g2 under scope taxes: chain [gather(0), g2(1)]. Before at depth 1
    // slots ahead of g2 among gather's children.
    const t = insertAtDepth(fixture(), 'f1', 'g2', 1, 'before', 'taxes')
    expect(childrenOf(t, 'gather').map((n) => n.id)).toEqual(['g1', 'f1', 'g2', 'g3'])
  })

  it('nesting under an anchor that already has children lands first, not last', () => {
    // The gap sits directly under `gather`, so the drop is visually just above
    // g1 — the indicator draws there. Appending after g3 instead would put the
    // row somewhere the pointer never was.
    const t = insertAtDepth(fixture(), 'f1', 'gather', 1, 'after', 'taxes')
    expect(childrenOf(t, 'gather').map((n) => n.id)).toEqual(['f1', 'g1', 'g2', 'g3'])
  })

  it('nesting under a collapsed anchor still lands first', () => {
    // A collapsed parent hides its children, so there is no visible gap between
    // them to aim at; first is the only position the gap can mean.
    const t = insertAtDepth(fixture(), 'f2', 'p2b', 3, 'after', 'taxes')
    expect(childrenOf(t, 'p2b').map((n) => n.id)).toEqual(['f2', 'p2b1', 'p2b2'])
  })

  it('handles a null scope (root-level list)', () => {
    // No scope: chain is the whole lineage. Anchor g2 → [taxes(0), gather(1), g2(2)].
    // Depth 0 drops beside taxes among the roots.
    const t = insertAtDepth(fixture(), 'f1', 'g2', 0, 'after', null)
    expect(roots(t).map((n) => n.id)).toEqual(['taxes', 'f1', 'flat'])
  })
})

describe('moveRow', () => {
  /** The visible row order, the way the app flattens the tree to render it. */
  function order(t: Tree, parentId: string | null = null): string[] {
    const out: string[] = []
    for (const child of childrenOf(t, parentId)) {
      out.push(child.id)
      if (!child.collapsed) out.push(...order(t, child.id))
    }
    return out
  }

  it('moves a row down past a plain sibling', () => {
    const t = moveRow(fixture(), 'g1', 'down', order(fixture()))
    expect(childrenOf(t, 'gather').map((n) => n.id)).toEqual(['g2', 'g1', 'g3'])
  })

  it('moves a row up past a plain sibling', () => {
    const t = moveRow(fixture(), 'g3', 'up', order(fixture()))
    expect(childrenOf(t, 'gather').map((n) => n.id)).toEqual(['g1', 'g3', 'g2'])
  })

  it('crosses out of its parent when it runs off the top', () => {
    // g1 is first under gather; the visible row above is gather itself, so it
    // lands beside gather rather than stopping dead.
    const t = moveRow(fixture(), 'g1', 'up', order(fixture()))
    expect(childrenOf(t, 'taxes').map((n) => n.id)).toEqual(['g1', 'gather', 'forms'])
  })

  it('crosses out of its parent when it runs off the bottom', () => {
    // g3 is last under gather; the next visible row is forms, and forms is an
    // open parent, so g3 steps inside it.
    const t = moveRow(fixture(), 'g3', 'down', order(fixture()))
    expect(childrenOf(t, 'forms').map((n) => n.id)).toEqual(['g3', 'p1', 'p2'])
  })

  it('steps over a folded parent rather than into it', () => {
    const base = fixture().map((n) => (n.id === 'forms' ? { ...n, collapsed: true } : n))
    const t = moveRow(base, 'g3', 'down', order(base))
    expect(childrenOf(t, 'taxes').map((n) => n.id)).toEqual(['gather', 'forms', 'g3'])
    expect(childrenOf(t, 'forms').map((n) => n.id)).toEqual(['p1', 'p2'])
  })

  it('carries its own subtree, stepping over it rather than into it', () => {
    // gather moving down must clear g1..g3 and land beside forms, not inside
    // its own children.
    const t = moveRow(fixture(), 'gather', 'down', order(fixture()))
    expect(childrenOf(t, 'forms').map((n) => n.id)).toEqual(['gather', 'p1', 'p2'])
    expect(childrenOf(t, 'gather').map((n) => n.id)).toEqual(['g1', 'g2', 'g3'])
  })

  it('does nothing at the very top or the very bottom', () => {
    const base = fixture()
    expect(moveRow(base, 'taxes', 'up', order(base))).toEqual(base)
    expect(moveRow(base, 'f2', 'down', order(base))).toEqual(base)
  })
})

describe('invalidTree', () => {
  const node = (id: string, parentId: string | null, extra: object = {}) => ({
    id,
    parentId,
    text: id,
    done: false,
    order: 0,
    collapsed: false,
    createdAt: 0,
    ...extra,
  })

  it('accepts a well-formed tree', () => {
    expect(invalidTree([node('a', null), node('b', 'a')])).toBeNull()
  })

  it('accepts an empty tree', () => {
    // A database with no projects is a legitimate state, not a broken one.
    expect(invalidTree([])).toBeNull()
  })

  it('rejects a node whose text is over the length cap', () => {
    // Import is the one route where a whole file becomes the database, so the
    // cap the op parsers enforce has to hold here too or it can be bypassed.
    const long = 'x'.repeat(MAX_TEXT_LENGTH + 1)
    expect(invalidTree([node('a', null, { text: long })])).toMatch(/tree\[0\]/)
  })

  it('accepts the optional root-only fields when present', () => {
    expect(invalidTree([node('a', null, { pinned: true, lastOpenedAt: 123 })])).toBeNull()
  })

  it('rejects anything that is not an array', () => {
    expect(invalidTree({ nodes: [] })).toMatch(/must be an array/)
    expect(invalidTree(null)).toMatch(/must be an array/)
    expect(invalidTree('[]')).toMatch(/must be an array/)
  })

  it('names the index of the first malformed node', () => {
    // The message is what a 400 shows, so it has to point at the bad row.
    expect(invalidTree([node('a', null), { id: 'b' }])).toBe('tree[1] is not a valid node')
  })

  it('rejects a stringly-typed number rather than coercing it', () => {
    // The reachable case: SQLite's own constraints accept this and store it,
    // and the mis-typed value only surfaces later as a mis-ordered list.
    expect(invalidTree([node('a', null, { order: '3' })])).toMatch(/not a valid node/)
    expect(invalidTree([node('a', null, { createdAt: '0' })])).toMatch(/not a valid node/)
  })

  it('rejects NaN and Infinity in the numeric fields', () => {
    // typeof NaN === 'number', so these slip past a bare typeof check and then
    // sort unpredictably.
    expect(invalidTree([node('a', null, { order: NaN })])).toMatch(/not a valid node/)
    expect(invalidTree([node('a', null, { createdAt: Infinity })])).toMatch(/not a valid node/)
  })

  it('rejects a wrongly-typed optional field', () => {
    expect(invalidTree([node('a', null, { pinned: 'yes' })])).toMatch(/not a valid node/)
    expect(invalidTree([node('a', null, { lastOpenedAt: 'today' })])).toMatch(/not a valid node/)
  })

  it('tolerates unknown extra keys', () => {
    // A field from a newer client shouldn't make the tree unreadable.
    expect(invalidTree([node('a', null, { somethingNew: 1 })])).toBeNull()
  })

  it('rejects duplicate ids', () => {
    // byId would find one node while removeNode drops both.
    expect(invalidTree([node('a', null), node('a', null)])).toBe('duplicate node id: a')
  })

  it('rejects a parentId that points at nothing', () => {
    // The branch would be orphaned out of every view while still stored.
    expect(invalidTree([node('a', null), node('b', 'ghost')])).toMatch(/parentId that doesn't exist/)
  })

  it('rejects a node that is its own parent', () => {
    expect(invalidTree([node('a', 'a')])).toBe('node a is its own ancestor')
  })

  it('rejects a longer parent cycle', () => {
    // Without the visited set this doesn't return a wrong answer — it walks the
    // cycle until the path array blows up. Cheap to check here, and the reason
    // lineageOf and depthOf can walk parent pointers without their own guard.
    expect(invalidTree([node('a', 'c'), node('b', 'a'), node('c', 'b')])).toMatch(/own ancestor/)
  })

  it('accepts a deep chain without mistaking it for a cycle', () => {
    // Depth alone must not trip the cycle check — the memoisation is what keeps
    // this linear, and a bug there would show up as a false rejection.
    const chain = Array.from({ length: 500 }, (_, i) =>
      node(`n${i}`, i === 0 ? null : `n${i - 1}`),
    )
    expect(invalidTree(chain)).toBeNull()
  })
})

describe('newId', () => {
  /**
   * Node ids are unique across the whole `nodes` table, not per owner, so a
   * collision is a failed write for whoever mints second. Both of the schemes
   * this replaced looked fine in a single-process test suite: the timestamp
   * version only collided across processes, and the ~41-bit random version
   * only at scale.
   */
  it('does not repeat within one process', () => {
    const ids = Array.from({ length: 100_000 }, () => newId())
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('does not collide across processes minting at the same moment', async () => {
    // The regression, and the reason this needs a fresh module registry rather
    // than a loop: ids were `n${Date.now()}${++seq}` off a module-level
    // counter. Two tabs (or a tab and the MCP server) starting in the same
    // millisecond both began at seq=1 and minted byte-identical ids. Resetting
    // the module is what a second process actually does.
    const fresh = async () => {
      vi.resetModules()
      return (await import('./tree')).newId
    }

    const [a, b] = [await fresh(), await fresh()]
    const now = Date.now()
    const batch = (mint: () => string) => Array.from({ length: 500 }, () => mint())
    const ids = [...batch(a), ...batch(b)]

    // Guard the premise: if this took longer than a millisecond the old scheme
    // would have passed on timestamp alone and the test would prove nothing.
    expect(Date.now() - now).toBeLessThan(50)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('resumeScope — where to land on open', () => {
  const withOpened = (stamps: Record<string, number>): Tree =>
    fixture().map((n) => (stamps[n.id] !== undefined ? { ...n, lastOpenedAt: stamps[n.id] } : n))

  it('returns the most recently opened project', () => {
    expect(resumeScope(withOpened({ taxes: 100, flat: 200 }))).toBe('flat')
    expect(resumeScope(withOpened({ taxes: 300, flat: 200 }))).toBe('taxes')
  })

  it('lands on the home list when nothing has been opened', () => {
    expect(resumeScope(fixture())).toBeNull()
  })

  it('lands on the home list for an empty tree', () => {
    expect(resumeScope([])).toBeNull()
  })

  it('lands on the project of a deep stamp, not the deep scope itself', () => {
    // Resuming into a subtask would drop you somewhere with no visible context.
    expect(resumeScope(withOpened({ p2b1: 900 }))).toBe('taxes')
  })

  it('lets a newer deep stamp beat an older project stamp', () => {
    expect(resumeScope(withOpened({ flat: 200, gather: 300 }))).toBe('taxes')
    expect(resumeScope(withOpened({ flat: 400, gather: 300 }))).toBe('flat')
  })

  it('ignores projects that have never been opened', () => {
    // `flat` is unstamped, so it loses to taxes regardless of tree order.
    expect(resumeScope(withOpened({ taxes: 1 }))).toBe('taxes')
  })

  it('is unaffected by pinning, which orders the list rather than the landing', () => {
    const t = withOpened({ taxes: 100, flat: 200 }).map((n) =>
      n.id === 'taxes' ? { ...n, pinned: true } : n,
    )
    expect(resumeScope(t)).toBe('flat')
  })
})

describe('reconcileDone re-derives a parent from its contents', () => {
  const t = (spec: Array<[string, string | null, boolean]>): Tree =>
    spec.map(([id, parentId, done], i) => ({
      id,
      parentId,
      text: id,
      done,
      order: i,
      collapsed: false,
      createdAt: 0,
    }))

  it('completes a leaf that gained an already-done child', () => {
    const out = reconcileDone(t([['a', null, false], ['b', 'a', true]]))
    expect(byId(out, 'a')!.done).toBe(true)
  })

  it('un-completes a done leaf that gained an unfinished child', () => {
    const out = reconcileDone(t([['a', null, true], ['b', 'a', false]]))
    expect(byId(out, 'a')!.done).toBe(false)
  })

  it('completes a parent whose last unfinished child was removed', () => {
    const out = reconcileDone(t([['a', null, false], ['b', 'a', true]]))
    expect(byId(out, 'a')!.done).toBe(true)
  })

  it('leaves a leaf alone — its done is the real fact', () => {
    const out = reconcileDone(t([['a', null, true], ['b', null, false]]))
    expect(byId(out, 'a')!.done).toBe(true)
    expect(byId(out, 'b')!.done).toBe(false)
  })

  it('rolls up through several levels in one pass', () => {
    const out = reconcileDone(
      t([
        ['root', null, false],
        ['mid', 'root', false],
        ['leaf', 'mid', true],
      ]),
    )
    expect(byId(out, 'mid')!.done).toBe(true)
    expect(byId(out, 'root')!.done).toBe(true)
  })

  it('one unfinished leaf keeps every ancestor open', () => {
    const out = reconcileDone(
      t([
        ['root', null, true],
        ['mid', 'root', true],
        ['x', 'mid', true],
        ['y', 'mid', false],
      ]),
    )
    expect(byId(out, 'mid')!.done).toBe(false)
    expect(byId(out, 'root')!.done).toBe(false)
  })
})

describe('pinnedItems — the shelf, arranged by hand', () => {
  const pin = (tree: Tree, ...ids: string[]) =>
    tree.map((n) => (ids.includes(n.id) ? { ...n, pinned: true } : n))
  const at = (tree: Tree, id: string, pinOrder: number) =>
    tree.map((n) => (n.id === id ? { ...n, pinOrder } : n))

  it('holds projects and tasks in one list', () => {
    // The shelf is arranged by hand, so it cannot also be grouped by kind —
    // the two rules would disagree the moment a task was dragged above a
    // project.
    const tree = pin(fixture(), 'taxes', 'g2')
    expect(pinnedItems(tree).map((p) => p.node.id).sort()).toEqual(['g2', 'taxes'])
  })

  it('gives a pinned project an empty trail', () => {
    // Which is also what says it is a project — a root has no lineage above it.
    const [{ trail }] = pinnedItems(pin(fixture(), 'taxes'))
    expect(trail).toEqual([])
  })

  it('follows pinOrder when it is set', () => {
    const tree = at(at(pin(fixture(), 'taxes', 'g2'), 'g2', 0), 'taxes', 1)
    expect(pinnedItems(tree).map((p) => p.node.id)).toEqual(['g2', 'taxes'])
  })

  it('sorts an unarranged pin after every arranged one', () => {
    // Absent means never dragged. Sorting those last means a new pin appears at
    // the end rather than displacing an order someone set by hand.
    const tree = at(pin(fixture(), 'taxes', 'g2'), 'g2', 0)
    expect(pinnedItems(tree).map((p) => p.node.id)).toEqual(['g2', 'taxes'])
  })

  it('falls back to depth then order with nothing arranged', () => {
    // The old shelf's rule, kept as the fallback so shipping pinOrder needs no
    // backfill and an untouched shelf looks the same as it did.
    const tree = pin(fixture(), 'p2b1', 'gather')
    expect(pinnedItems(tree).map((p) => p.node.id)).toEqual(['gather', 'p2b1'])
  })

  it('drops a pin when its node is deleted', () => {
    // Membership is still the flag, so a deleted node takes its shelf entry
    // with it and no stale pinOrder can resurrect it.
    const tree = removeNode(at(pin(fixture(), 'p2b1'), 'p2b1', 0), 'p2b')
    expect(pinnedItems(tree)).toEqual([])
  })

  it('has nothing to show when nothing is pinned', () => {
    expect(pinnedItems(fixture())).toEqual([])
  })
})

describe('fingerprint', () => {
  // The server stamps every broadcast with this, and a client compares it to
  // its own. Two things have to hold: it changes when anything sync cares about
  // changes, and Swift computes the same string — see the matching test in
  // AnsaCoreTests, which pins the same constant on the same fixture.

  const fixtureFile = join(dirname(fileURLToPath(import.meta.url)), '../ios/AnsaCore/Tests/AnsaCoreTests/Fixtures/real-tree.json')
  const real = (): Tree => (JSON.parse(readFileSync(fixtureFile, 'utf8')) as { tree: Tree }).tree

  it('is the pinned constant for the shared fixture', () => {
    // If this changes, the Swift side has to change with it, or every phone
    // refetches the tree after every edit.
    expect(fingerprint(real())).toBe('e314e562')
    expect(fingerprint([])).toBe('811c9dc5')
  })

  it('does not depend on storage order', () => {
    const tree = real()
    expect(fingerprint([...tree].reverse())).toBe(fingerprint(tree))
  })

  it('changes for every field sync has to agree on', () => {
    const base = real()
    const edits: ((n: Node) => Node)[] = [
      (n) => ({ ...n, text: n.text + '!' }),
      (n) => ({ ...n, done: !n.done }),
      (n) => ({ ...n, order: n.order + 1 }),
      (n) => ({ ...n, collapsed: !n.collapsed }),
      (n) => ({ ...n, pinned: !n.pinned }),
      (n) => ({ ...n, pinOrder: 3 }),
      (n) => ({ ...n, parentId: null }),
    ]
    for (const edit of edits) {
      const changed = base.map((n, i) => (i === 3 ? edit(n) : n))
      expect(fingerprint(changed)).not.toBe(fingerprint(base))
    }
  })

  it('ignores timestamps', () => {
    // Doubles on the iOS side; the chance of two languages printing the same
    // decimal is not something sync should ride on, and nothing sync cares
    // about depends on them.
    const base = real()
    const stamped = base.map((n) => ({ ...n, createdAt: n.createdAt + 0.5, lastOpenedAt: 12345.678 }))
    expect(fingerprint(stamped)).toBe(fingerprint(base))
  })
})
