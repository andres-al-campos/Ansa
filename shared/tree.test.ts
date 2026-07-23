import { describe, expect, it } from 'vitest'
import {
  addChild,
  addSubtree,
  childrenOf,
  indent,
  isAncestor,
  isLeaf,
  leavesUnder,
  lineageOf,
  moveNode,
  outdent,
  progressOf,
  removeNode,
  roots,
  setDone,
  subtreeOf,
  type Tree,
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
