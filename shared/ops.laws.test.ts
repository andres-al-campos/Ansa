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

import { caseArb, opArb, treeArb } from './ops.arbitraries.ts'
import { applyOp, type Op } from './ops.ts'
import { invalidTree, type Node, type Tree } from './tree.ts'

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
      fc.property(caseArb(), ([start, ops]) => {
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
