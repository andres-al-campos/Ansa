/**
 * Laws for applyOp: rules that must hold for every tree and every op, checked
 * against random ones. When a law breaks, fast-check shrinks the case to the
 * smallest tree and op sequence that still breaks it and prints them.
 *
 * The example tests in ops.test.ts say what each op does. These say what no op
 * may ever do, which is the part a new op or a refactor can get wrong without
 * any example noticing.
 */
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import { applyOp, type Op } from './ops.ts'
import { invalidTree, reconcileDone, type Node, type Tree } from './tree.ts'

/** A valid starting tree: dense sibling orders and done already reconciled. */
const treeArb: fc.Arbitrary<Tree> = fc
  .array(fc.record({ parent: fc.nat(), root: fc.boolean(), done: fc.boolean() }), {
    maxLength: 10,
  })
  .map((specs) => {
    const tree: Node[] = []
    const next = new Map<string | null, number>()
    specs.forEach((s, i) => {
      // Parents always come earlier, so the result is acyclic by construction.
      const parentId = i === 0 || s.root ? null : `n${s.parent % i}`
      const order = next.get(parentId) ?? 0
      next.set(parentId, order + 1)
      tree.push({
        id: `n${i}`,
        parentId,
        text: `t${i}`,
        done: s.done,
        order,
        collapsed: false,
        createdAt: 0,
      })
    })
    return reconcileDone(tree)
  })

/** Ops that name nodes of a tree with up to 10 nodes, plus ids that don't exist. */
const idArb = fc.oneof(
  fc.integer({ min: 0, max: 9 }).map((i) => `n${i}`),
  fc.constant('ghost'),
)
const parentArb = fc.oneof(idArb, fc.constant(null))
let fresh = 0
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ parentId: parentArb, text: fc.string({ maxLength: 3 }) }).map(
    (o): Op => ({ op: 'addChild', id: `new${fresh++}`, at: 0, ...o }),
  ),
  parentArb.map(
    (parentId): Op => ({
      op: 'addSubtree',
      ids: [`new${fresh++}`, `new${fresh++}`],
      parentId,
      nodes: [{ text: 'a', children: [{ text: 'b' }] }],
      at: 0,
    }),
  ),
  fc.record({ id: idArb, text: fc.string({ maxLength: 3 }) }).map((o): Op => ({ op: 'setText', ...o })),
  fc.record({ id: idArb, done: fc.boolean() }).map((o): Op => ({ op: 'setDone', ...o })),
  fc.record({ id: idArb, trash: fc.boolean() }).map((o): Op => ({ op: 'removeNode', ...o })),
  fc
    .record({ id: idArb, parentId: parentArb, index: fc.integer({ min: -1, max: 6 }) })
    .map((o): Op => ({ op: 'moveNode', ...o })),
  idArb.map((id): Op => ({ op: 'indent', id })),
  idArb.map((id): Op => ({ op: 'outdent', id })),
  idArb.map((id): Op => ({ op: 'adoptFollowing', id })),
  fc
    .record({
      id: idArb,
      anchorId: idArb,
      depth: fc.integer({ min: 0, max: 4 }),
      side: fc.constantFrom('before' as const, 'after' as const),
      scope: parentArb,
    })
    .map((o): Op => ({ op: 'insertAtDepth', ...o })),
  idArb.map((id): Op => ({ op: 'toggleCollapsed', id })),
  fc.record({ id: idArb, pinned: fc.boolean() }).map((o): Op => ({ op: 'setPinned', ...o })),
  fc.record({ id: idArb, order: fc.nat(5) }).map((o): Op => ({ op: 'setPinOrder', ...o })),
  fc.record({ id: idArb, at: fc.nat() }).map((o): Op => ({ op: 'markOpened', ...o })),
)

/** Every way a tree can be broken, as readable strings; empty when it's sound. */
function treeProblems(tree: Tree): string[] {
  const problems: string[] = []
  const byId = new Map(tree.map((n) => [n.id, n]))
  if (byId.size !== tree.length) problems.push('two nodes share an id')
  for (const n of tree) {
    if (n.parentId !== null && !byId.has(n.parentId)) {
      problems.push(`${n.id} points at missing parent ${n.parentId}`)
    }
    const seen = new Set<string>()
    for (let p: Node | undefined = n; p; p = p.parentId === null ? undefined : byId.get(p.parentId)) {
      if (seen.has(p.id)) {
        problems.push(`${n.id} is inside a cycle`)
        break
      }
      seen.add(p.id)
    }
  }
  const orders = new Map<string | null, Set<number>>()
  for (const n of tree) {
    const used = orders.get(n.parentId) ?? new Set()
    if (used.has(n.order)) problems.push(`two children of ${n.parentId} share order ${n.order}`)
    used.add(n.order)
    orders.set(n.parentId, used)
  }
  return problems
}

describe('applyOp laws', () => {
  // applyOp itself can produce a broken tree: adding or moving under a parent
  // that's gone leaves an orphan. The server runs invalidTree on every result
  // and refuses those writes, so the law is about what gets stored: every
  // broken tree an op can make is one invalidTree catches.
  test('law 1: the server never stores a broken tree', () => {
    fc.assert(
      fc.property(treeArb, fc.array(opArb, { maxLength: 8 }), (start, ops) => {
        let tree = start
        for (const op of ops) {
          const next = applyOp(tree, op).tree
          if (invalidTree(next) === null) tree = next
          expect(treeProblems(tree), JSON.stringify(op)).toEqual([])
        }
      }),
      { numRuns: 2000 },
    )
  })

  test('law 2: an op naming a node that does not exist changes nothing', () => {
    fc.assert(
      fc.property(treeArb, opArb, (tree, op) => {
        // Only ops whose subject is missing; addChild/addSubtree create theirs.
        if (!('id' in op) || op.op === 'addChild') return
        const ghost = { ...op, id: 'ghost' } as Op
        expect(applyOp(tree, ghost).tree).toEqual(tree)
      }),
      { numRuns: 2000 },
    )
  })

  // Position only. Done is not restored: tabbing a finished task under an open
  // one ticks the open one, and Shift-Tab leaves it ticked, because a task's
  // own done isn't kept while it has children. Accepted; see features/check-off.md.
  test('law 3: outdent puts an indented task back where it was', () => {
    fc.assert(
      fc.property(treeArb, fc.nat(9), (tree, i) => {
        const id = `n${i}`
        const indented = applyOp(tree, { op: 'indent', id }).tree
        // applyOp always returns a fresh array, so a refused indent shows as equal.
        fc.pre(JSON.stringify(indented) !== JSON.stringify(tree))
        const place = (t: Tree) => t.map(({ done: _, ...rest }) => rest)
        expect(place(applyOp(indented, { op: 'outdent', id }).tree)).toEqual(place(tree))
      }),
      { numRuns: 2000 },
    )
  })
})
