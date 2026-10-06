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

/**
 * Ids for a tree of `size` nodes: mostly ones that exist, now and then one
 * that doesn't. Picking from n0..n9 whatever the tree's size aimed about half
 * of all ops at missing tasks, and an op on a missing task changes nothing, so
 * it tests little beyond law 2.
 */
function idsFor(size: number) {
  const id = fc.oneof(
    { arbitrary: fc.integer({ min: 0, max: Math.max(size - 1, 0) }).map((i) => `n${i}`), weight: 19 },
    { arbitrary: fc.constant('ghost'), weight: 1 },
  )
  const parent = fc.oneof({ arbitrary: id, weight: 5 }, { arbitrary: fc.constant(null), weight: 1 })
  return { id, parent }
}

let fresh = 0

/** One op of any kind, naming nodes of a tree with `size` nodes. */
export function opFor(size: number): fc.Arbitrary<Op> {
  const { id: idArb, parent: parentArb } = idsFor(size)
  return fc.oneof(
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
}

/** One op for a tree of unknown size, up to 10 nodes. */
export const opArb: fc.Arbitrary<Op> = opFor(10)

/**
 * A random tree and a sequence of ops on it that mostly works on one task at a
 * time, the way editing does: add a task, indent it, tick it, outdent it. Each
 * op, with probability `focus`, is retargeted at the task the previous op
 * touched or created (an add goes under it). The rest keep their random target,
 * so combinations nobody does on purpose still come up.
 */
export function caseArb(focus = 0.7, maxLength = 8): fc.Arbitrary<[Tree, Op[]]> {
  return treeArb.chain((tree) =>
    fc
      // An integer roll, unbiased: fast-check skews numbers toward edge values,
      // and its doubles crowd near 0 even with noBias, so a double roll would
      // fire the focus almost every time whatever `focus` says.
      .array(fc.tuple(opFor(tree.length), fc.noBias(fc.integer({ min: 0, max: 999 }))), { maxLength })
      .map((steps): [Tree, Op[]] => {
        let cursor: string | null = null
        const ops = steps.map(([op, roll]) => {
          let next = op
          if (cursor !== null && roll < focus * 1000) {
            if (op.op === 'addChild' || op.op === 'addSubtree') next = { ...op, parentId: cursor }
            else next = { ...op, id: cursor }
          }
          cursor = next.op === 'addChild' ? next.id : next.op === 'addSubtree' ? next.ids[0] : next.id
          return next
        })
        return [tree, ops]
      }),
  )
}
