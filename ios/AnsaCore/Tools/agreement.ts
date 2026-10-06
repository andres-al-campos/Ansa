/**
 * The TypeScript half of check-agreement.sh.
 *
 *   tsx agreement.ts gen <cases.json> <seed>       random cases, with TS's results
 *   tsx agreement.ts compare <cases.json> <swift.json>
 *
 * Only ops the server would accept are generated (parseOp), since nothing else
 * reaches applyOp on either side.
 */
import fc from 'fast-check'
import { readFileSync, writeFileSync } from 'node:fs'

import { caseArb } from '../../../shared/ops.arbitraries.ts'
import { applyOp, parseOp, type Op } from '../../../shared/ops.ts'
import type { Tree } from '../../../shared/tree.ts'

const RUNS = 2000

interface Case {
  tree: Tree
  ops: Op[]
  /** The tree after each op, as TypeScript's applyOp leaves it. */
  expected: Tree[]
}

/** Array order and absent-vs-undefined fields mean nothing; sort and drop them. */
function canonical(tree: Tree): string {
  const sorted = [...tree].sort((a, b) => (a.id < b.id ? -1 : 1))
  return JSON.stringify(sorted, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort())
      : v,
  )
}

const [mode, casesPath, arg] = process.argv.slice(2)

if (mode === 'gen') {
  const samples = fc.sample(caseArb(), { numRuns: RUNS, seed: Number(arg) })
  const cases: Case[] = samples.map(([tree, all]) => {
    const ops = all.filter((op) => !('error' in parseOp(op)))
    const expected: Tree[] = []
    let t = tree
    for (const op of ops) expected.push((t = applyOp(t, op).tree))
    return { tree, ops, expected }
  })
  writeFileSync(casesPath, JSON.stringify(cases))
} else if (mode === 'compare') {
  const cases: Case[] = JSON.parse(readFileSync(casesPath, 'utf8'))
  const swift: Tree[][] = JSON.parse(readFileSync(arg, 'utf8'))
  const failures: { c: Case; step: number; size: number }[] = []
  cases.forEach((c, i) => {
    const step = c.expected.findIndex((t, j) => canonical(t) !== canonical(swift[i][j]))
    if (step >= 0) failures.push({ c, step, size: c.tree.length + step })
  })
  if (failures.length === 0) {
    console.log(`ok — Swift and TypeScript applyOp agree on ${cases.length} random cases`)
    process.exit(0)
  }
  // The smallest failure is the easiest to read; there's no shrinking across
  // the process boundary, so sorting by size stands in for it.
  const { c, step } = failures.sort((a, b) => a.size - b.size)[0]
  const before = step === 0 ? c.tree : c.expected[step - 1]
  const swiftAfter = swift[cases.indexOf(c)][step]
  const byId = (t: Tree) => new Map(t.map((n) => [n.id, canonical([n])]))
  const ts = byId(c.expected[step])
  const sw = byId(swiftAfter)
  const ids = [...new Set([...ts.keys(), ...sw.keys()])].sort()
  console.error(`Swift and TypeScript applyOp disagree on ${failures.length} of ${cases.length} cases.`)
  console.error(`Smallest: this op on this tree.\n`)
  console.error(`op:   ${JSON.stringify(c.ops[step])}`)
  console.error(`tree: ${canonical(before)}\n`)
  for (const id of ids) {
    if (ts.get(id) === sw.get(id)) continue
    console.error(`  ${id}`)
    console.error(`    TypeScript: ${ts.get(id) ?? '(absent)'}`)
    console.error(`    Swift:      ${sw.get(id) ?? '(absent)'}`)
  }
  console.error(`\nThe server runs the TypeScript, so it is the reference. Fix the Swift`)
  console.error(`op in ios/AnsaCore/Sources/AnsaCore to match shared/ops.ts and shared/tree.ts, or fix both`)
  console.error(`if TypeScript is the one that's wrong.`)
  process.exit(1)
} else {
  console.error('Usage: tsx agreement.ts gen <cases.json> <seed> | compare <cases.json> <swift.json>')
  process.exit(2)
}
