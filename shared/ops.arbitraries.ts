/**
 * Random trees and ops for the applyOp laws and the Swift agreement check.
 *
 * Test-only: nothing the app ships imports this, so fast-check stays a dev
 * dependency.
 */
import fc from 'fast-check'

import type { Op } from './ops.ts'
import { reconcileDone, type Node, type Tree } from './tree.ts'

/** A valid starting tree: dense sibling orders and done already reconciled. */
export const treeArb: fc.Arbitrary<Tree> = fc
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
export const opArb: fc.Arbitrary<Op> = fc.oneof(
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
