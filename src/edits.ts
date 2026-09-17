/**
 * The tree half of the editing keys.
 *
 * Each handler in the outliner is a *when* — "Enter on the title", "Tab while
 * editing" — and those can't be lifted out of the component, because what they
 * share is its state, not a computation. What can be lifted is the part that
 * decides: given a tree and what you typed, what does the tree become, what
 * goes on the wire, and which row should hold the caret afterwards.
 *
 * That question is pure, and it is where these keys are actually tricky —
 * committing text and restructuring in one value so neither is lost, keeping
 * the local tree and its op in step, not stranding a row inside a fold. The
 * component keeps the state and applies the result; this decides it.
 */

import { applyOp, type Op } from '@shared/ops'
import {
  addChild,
  byId,
  childrenOf,
  clampText,
  moveNode,
  moveRow,
  newId,
  removeNode,
  setText,
  toggleCollapsed,
  type NodeId,
  type Tree,
} from '@shared/tree'

/**
 * What an editing key does: the tree it produces, the ops describing that same
 * change for the server, and where the caret lands.
 *
 * `focus` is the row to edit next; `null` means leave edit mode. It is a
 * separate field rather than something the caller infers from the tree, because
 * "which row now holds the caret" genuinely doesn't follow from the tree — the
 * same resulting tree wants the caret in different places depending on the key.
 */
export interface Edit {
  tree: Tree
  ops: Op[]
  focus: NodeId | null
}

/** No change: the key was a no-op, and even the caret stays put. */
function unchanged(tree: Tree, focus: NodeId | null): Edit {
  return { tree, ops: [], focus }
}

/**
 * Enter while editing a task: commit the text and open a fresh empty sibling.
 *
 * Both halves are one tree value so the added row can't be dropped by the blur
 * the old input fires on its way out. The new node's id and timestamp are
 * minted here and handed to the op, so the server creates the *same* node
 * rather than one of its own with a different id.
 */
export function commitAndAddSiblingEdit(
  tree: Tree,
  id: NodeId,
  text: string,
  scope: NodeId | null,
): Edit {
  const trimmed = clampText(text.trim())
  const parentId = byId(tree, id)?.parentId ?? scope
  const renamed = trimmed ? setText(tree, id, trimmed) : removeNode(tree, id)
  const childId = newId()
  const at = Date.now()
  const { tree: added } = addChild(renamed, parentId, '', childId, at)
  const ops: Op[] = [
    trimmed ? { op: 'setText', id, text: trimmed } : { op: 'removeNode', id },
    { op: 'addChild', id: childId, parentId, text: '', at },
  ]
  // addChild appends, which drops the new row at the bottom of the list — far
  // from the caret when you pressed Enter halfway up a tree. Slot it directly
  // after the current row instead. When that row was just removed for being
  // empty it's no longer among the siblings, and appending is already right.
  const siblings = childrenOf(added, parentId)
  const index = siblings.findIndex((n) => n.id === id)
  let next = added
  if (index !== -1 && index + 1 !== siblings.length - 1) {
    next = moveNode(added, childId, parentId, index + 1)
    ops.push({ op: 'moveNode', id: childId, parentId, index: index + 1 })
  }
  return { tree: next, ops, focus: childId }
}

/**
 * Leaving a task row — blur, or Up/Down onto another row.
 *
 * An emptied row is a deletion, which is how outliners behave. That has to fire
 * even when the stored text was *already* empty: a just-created row left
 * without typing anything is exactly that case, and treating "empty and
 * unchanged" as a no-op would strand it. A non-empty unchanged row writes
 * nothing at all, or the first Cmd+Z after simply leaving a row would appear to
 * do nothing.
 */
export function commitEditEdit(tree: Tree, id: NodeId, text: string, focus: NodeId | null): Edit {
  const trimmed = clampText(text.trim())
  if (trimmed === '') {
    if (!byId(tree, id)) return unchanged(tree, focus)
    return { tree: removeNode(tree, id), ops: [{ op: 'removeNode', id }], focus }
  }
  if (byId(tree, id)?.text === trimmed) return unchanged(tree, focus)
  return { tree: setText(tree, id, trimmed), ops: [{ op: 'setText', id, text: trimmed }], focus }
}

/**
 * Tab / Shift-Tab: commit the live text, then re-nest, keeping the row in edit
 * mode.
 *
 * Which structural op applies depends on where the row sits, so it's decided
 * once and used for both the local tree and the wire — deriving it twice would
 * risk the two disagreeing.
 */
export function reindentEdit(tree: Tree, id: NodeId, text: string, dir: 'in' | 'out'): Edit {
  const trimmed = clampText(text.trim())
  const withText = setText(tree, id, trimmed)
  let structural: Op
  if (dir === 'in') {
    structural = { op: 'indent', id }
  } else {
    // Outdenting a top-level task (parent is a project root) would otherwise
    // fling it up to the root and turn it into its own project. Instead, keep
    // it in place and pull the rows below it in as its children.
    const node = byId(withText, id)
    const parent = node ? byId(withText, node.parentId ?? '') : undefined
    structural =
      parent && parent.parentId === null ? { op: 'adoptFollowing', id } : { op: 'outdent', id }
  }
  const { tree: moved } = applyOp(withText, structural)
  const ops: Op[] = [{ op: 'setText', id, text: trimmed }, structural]
  // Tab nests the row under the sibling above it. If that sibling is folded,
  // the row lands inside a closed subtree and drops off screen — it looks
  // deleted. Unfold the new parent so the row is still where you left it.
  // The drag-and-drop path does the same on a drop-into.
  let next = moved
  const parentId = byId(moved, id)?.parentId
  const parent = parentId ? byId(moved, parentId) : undefined
  if (parent?.collapsed) {
    next = toggleCollapsed(moved, parent.id)
    ops.push({ op: 'toggleCollapsed', id: parent.id })
  }
  return { tree: next, ops, focus: id }
}

/**
 * Alt+Up/Down: commit the live text, then move the row one line through the
 * visible list.
 *
 * `order` is the visible row ids, because "one row" means one row *as drawn*: a
 * folded subtree is a single line, and hidden rows are never landed on. The
 * resulting move is read back off the tree so the server replays the same
 * destination without needing to know anything about what's on screen.
 */
export function reorderWithTextEdit(
  tree: Tree,
  id: NodeId,
  text: string,
  dir: 'up' | 'down',
  order: NodeId[],
): Edit {
  const trimmed = clampText(text.trim())
  const withText = setText(tree, id, trimmed)
  const ops: Op[] = [{ op: 'setText', id, text: trimmed }]
  const next = moveRow(withText, id, dir, order)
  const moved = byId(next, id)
  // At either end of the list there's nowhere to go — commit the text and stop.
  if (moved && next !== withText) {
    const index = childrenOf(next, moved.parentId).findIndex((n) => n.id === id)
    ops.push({ op: 'moveNode', id, parentId: moved.parentId, index })
  }
  return { tree: next, ops, focus: id }
}

/**
 * Enter on the project title. An empty project flows straight on into its first
 * task, since naming it and filling it are one motion.
 *
 * Returns null when the title should just be committed normally — the caller
 * owns that path because it can also mean backing out of a project entirely.
 */
export function titleAndFirstTaskEdit(tree: Tree, id: NodeId, text: string): Edit | null {
  const trimmed = clampText(text.trim())
  if (!trimmed || childrenOf(tree, id).length > 0) return null
  const named = setText(tree, id, trimmed)
  const childId = newId()
  const at = Date.now()
  const { tree: next } = addChild(named, id, '', childId, at)
  return {
    tree: next,
    ops: [
      { op: 'setText', id, text: trimmed },
      { op: 'addChild', id: childId, parentId: id, text: '', at },
    ],
    focus: childId,
  }
}
