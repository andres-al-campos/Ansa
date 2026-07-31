/**
 * The editing keys, checked as tree transforms.
 *
 * These were reachable only through the component's state, so the cases that
 * actually bite — the new row landing next to the caret rather than at the
 * bottom, an unchanged row writing nothing, Tab unfolding the parent it just
 * nested into — could only be checked by driving the UI. Now they're arguments
 * in and a value out.
 *
 * Every case asserts the ops alongside the tree. The local tree is what you
 * see; the ops are what the server replays. Checking only the tree would let
 * the two drift apart, which is the one failure this design exists to prevent.
 */

import { expect, test } from 'vitest'
import {
  commitAndAddSiblingEdit,
  commitEditEdit,
  reindentEdit,
  reorderWithTextEdit,
  titleAndFirstTaskEdit,
} from './edits'
import { applyOp } from '@shared/ops'
import { byId, childrenOf, type Tree } from '@shared/tree'

const node = (id: string, parentId: string | null, text: string, order: number, extra = {}) => ({
  id,
  parentId,
  text,
  done: false,
  order,
  collapsed: false,
  createdAt: 0,
  ...extra,
})

// A project `p` holding three tasks.
const tree: Tree = [
  node('p', null, 'Project', 0),
  node('a', 'p', 'a', 0),
  node('b', 'p', 'b', 1),
  node('c', 'p', 'c', 2),
]

const textsUnder = (t: Tree, parentId: string | null) =>
  childrenOf(t, parentId).map((n) => n.text)

test('Enter mid-list puts the new row right after the one you were on', () => {
  // The whole point of the moveNode step: addChild appends, which would drop
  // the new row below `c` — far from where the caret was.
  const edit = commitAndAddSiblingEdit(tree, 'a', 'a edited', null)
  expect(textsUnder(edit.tree, 'p')).toEqual(['a edited', '', 'b', 'c'])
  expect(edit.focus).toBe(childrenOf(edit.tree, 'p')[1].id)
})

test('Enter on the last row appends without a redundant move', () => {
  // Already in place — emitting a moveNode here would be a no-op the server
  // still has to replay.
  const edit = commitAndAddSiblingEdit(tree, 'c', 'c', null)
  expect(textsUnder(edit.tree, 'p')).toEqual(['a', 'b', 'c', ''])
  expect(edit.ops.map((o) => o.op)).toEqual(['setText', 'addChild'])
})

test('Enter on an emptied row removes it and still opens a fresh one', () => {
  const edit = commitAndAddSiblingEdit(tree, 'b', '   ', null)
  expect(textsUnder(edit.tree, 'p')).toEqual(['a', 'c', ''])
  expect(edit.ops[0]).toEqual({ op: 'removeNode', id: 'b' })
})

test('the ops rebuild the same tree the local edit produced', () => {
  // The op-replay contract: the server applies the ops, never the tree. If
  // these two disagree, the two sides silently diverge.
  const edit = commitAndAddSiblingEdit(tree, 'a', 'a edited', null)
  let replayed = tree
  for (const op of edit.ops) replayed = applyOp(replayed, op).tree
  expect(textsUnder(replayed, 'p')).toEqual(textsUnder(edit.tree, 'p'))
})

test('leaving an unchanged row writes nothing', () => {
  // An undo step for a row you only looked at would make the first Cmd+Z
  // appear to do nothing.
  expect(commitEditEdit(tree, 'a', 'a', null).ops).toEqual([])
  expect(commitEditEdit(tree, 'a', '  a  ', null).ops).toEqual([])
})

test('leaving an emptied row deletes it', () => {
  const edit = commitEditEdit(tree, 'b', '', null)
  expect(byId(edit.tree, 'b')).toBeUndefined()
  expect(edit.ops).toEqual([{ op: 'removeNode', id: 'b' }])
})

test('leaving a row that is already gone writes nothing', () => {
  // The trailing blur after a row was removed some other way. Re-emitting the
  // removal would cost a second undo step for one deletion.
  const without = commitEditEdit(tree, 'b', '', null).tree
  expect(commitEditEdit(without, 'b', '', null).ops).toEqual([])
})

test('Tab unfolds the parent it nests into', () => {
  // Otherwise the row lands inside a closed subtree and looks deleted.
  const folded = tree.map((n) => (n.id === 'a' ? { ...n, collapsed: true } : n))
  const edit = reindentEdit(folded, 'b', 'b', 'in')
  expect(byId(edit.tree, 'b')?.parentId).toBe('a')
  expect(byId(edit.tree, 'a')?.collapsed).toBe(false)
  expect(edit.ops.map((o) => o.op)).toEqual(['setText', 'indent', 'toggleCollapsed'])
})

test('Tab into an already-open parent leaves the fold alone', () => {
  const edit = reindentEdit(tree, 'b', 'b', 'in')
  expect(edit.ops.map((o) => o.op)).toEqual(['setText', 'indent'])
})

test('Shift-Tab on a top-level task adopts the rows below instead of escaping', () => {
  // Outdenting out of a project root would fling the row up to the root list
  // and turn it into its own project, which is never what Shift-Tab means.
  const edit = reindentEdit(tree, 'b', 'b', 'out')
  expect(edit.ops[1]).toEqual({ op: 'adoptFollowing', id: 'b' })
  expect(byId(edit.tree, 'b')?.parentId).toBe('p')
  expect(byId(edit.tree, 'c')?.parentId).toBe('b')
})

test('Tab commits the live text along with the move', () => {
  // The reparent must not discard what you had just typed.
  const edit = reindentEdit(tree, 'b', 'typed', 'in')
  expect(byId(edit.tree, 'b')?.text).toBe('typed')
})

test('Alt+Down moves the row and emits where it landed', () => {
  const order = ['a', 'b', 'c']
  const edit = reorderWithTextEdit(tree, 'a', 'a', 'down', order)
  expect(textsUnder(edit.tree, 'p')).toEqual(['b', 'a', 'c'])
  expect(edit.ops[1]).toEqual({ op: 'moveNode', id: 'a', parentId: 'p', index: 1 })
})

test('Alt+Up at the top commits the text and emits no move', () => {
  const edit = reorderWithTextEdit(tree, 'a', 'typed', 'up', ['a', 'b', 'c'])
  expect(byId(edit.tree, 'a')?.text).toBe('typed')
  expect(edit.ops).toEqual([{ op: 'setText', id: 'a', text: 'typed' }])
})

test('Enter on an empty project names it and opens its first task', () => {
  const empty: Tree = [node('q', null, '', 0)]
  const edit = titleAndFirstTaskEdit(empty, 'q', 'Groceries')!
  expect(byId(edit.tree, 'q')?.text).toBe('Groceries')
  expect(childrenOf(edit.tree, 'q')).toHaveLength(1)
  expect(edit.focus).toBe(childrenOf(edit.tree, 'q')[0].id)
})

test('Enter on a project that already has tasks is just a rename', () => {
  // You came to rename it; silently adding a row would be a surprise. null
  // hands the key back to the plain title-commit path.
  expect(titleAndFirstTaskEdit(tree, 'p', 'Renamed')).toBeNull()
})

test('Enter on an unnamed project is not a rename either', () => {
  // Handed back so the caller can back out of creating the project, rather
  // than leaving an "Untitled" holding one blank row.
  expect(titleAndFirstTaskEdit([node('q', null, '', 0)], 'q', '   ')).toBeNull()
})
