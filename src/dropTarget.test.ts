/**
 * The drag hit-test, checked directly.
 *
 * This logic used to live inside the component, reading three refs and the DOM,
 * so the only way at it was to render the app and synthesise pointer events —
 * which is why the band arithmetic and the gap-depth clamping had no tests of
 * their own. Now that it takes its inputs as arguments, the cases that actually
 * bite can be stated as data.
 */

import { expect, test } from 'vitest'
import { dropTargetAt, type HitRow, type RowHit } from './dropTarget'
import type { Tree } from '@shared/tree'

// Three rows, 32px tall, stacked from y=0. `a` is a parent of `b`.
const tree: Tree = [
  { id: 'a', parentId: null, text: 'a', done: false, order: 0, collapsed: false, createdAt: 0 },
  { id: 'b', parentId: 'a', text: 'b', done: false, order: 1, collapsed: false, createdAt: 0 },
  { id: 'c', parentId: null, text: 'c', done: false, order: 2, collapsed: false, createdAt: 0 },
]

const visible: HitRow[] = [
  { id: 'a', depth: 0 },
  { id: 'b', depth: 1 },
  { id: 'c', depth: 0 },
]

const hits: RowHit[] = [
  { id: 'a', top: 0, bottom: 32, left: 0, height: 32 },
  { id: 'b', top: 32, bottom: 64, left: 0, height: 32 },
  { id: 'c', top: 64, bottom: 96, left: 0, height: 32 },
]

// The geometry the component passes in, from GEOMETRY in Outliner.tsx.
const GUIDE_X0 = 37
const INDENT = 24

const at = (x: number, y: number, dragging = 'c') =>
  dropTargetAt(x, y, dragging, tree, visible, hits, GUIDE_X0, INDENT)

test('the middle half of a row nests into it', () => {
  // 0.25–0.75 of the row's height is the 'into' band. Row `a` spans 0–32, so
  // its middle is 8–24.
  expect(at(100, 16)?.mode).toBe('into')
  expect(at(100, 16)?.id).toBe('a')
})

test('the top and bottom quarters are insertion gaps, not nests', () => {
  // Above the middle band of `b` (32–64): the gap between `a` and `b`.
  expect(at(100, 34)?.mode).toBe('after')
  // Below it: the gap between `b` and `c`.
  expect(at(100, 62)?.mode).toBe('after')
})

test("the dragged row's own slot offers to put it back", () => {
  // Dropping on the slim slot the lifted row still holds is a no-op return,
  // never a move — the one target that must not be confused with a real drop.
  expect(at(100, 80, 'c')).toEqual({ id: 'c', mode: 'return' })
})

test('a row is never nested into its own descendant', () => {
  // Descendants aren't rendered mid-drag, so this is belt-and-braces: dragging
  // `a` over its child `b` must refuse rather than build a cycle.
  expect(at(100, 48, 'a')).toBeNull()
})

test('the pointer x picks the depth in a gap', () => {
  // The gap below `b` (depth 1) spans depth 0 to depth 2: 0 outdents to the
  // root list, 1 is a sibling of `b`, and 2 nests *under* `b` — the "row above
  // can take children" case. Far left and far right clamp to those ends, which
  // is what the insertion line's indent is showing.
  expect(at(0, 62)?.depth).toBe(0)
  expect(at(500, 62)?.depth).toBe(2)
})

test('a gap cannot indent past one level deeper than the row above it', () => {
  // The clamp is what stops a drag from inventing depth. However far right the
  // pointer goes, the deepest legal drop below `a` (depth 0) is depth 1 — a
  // child of `a` — never depth 2 under a row that has no depth-1 ancestor.
  expect(at(9999, 34)?.depth).toBe(1)
})

test('a pointer past the last row hits nothing', () => {
  // Below every row box: no target rather than the nearest one, so releasing in
  // empty space cancels instead of dropping somewhere arbitrary.
  expect(at(100, 500)).toBeNull()
})
