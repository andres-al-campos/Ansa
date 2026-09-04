/**
 * Operations: the unit of change that travels between clients and the server.
 *
 * The app used to send the whole tree after every edit, which made concurrent
 * writes last-writer-wins over the entire document — a Claude on the MCP adding
 * a task while you renamed one meant whichever save landed second erased the
 * other, even on unrelated branches. Sending the *operation* instead makes the
 * server the serialization point: two writers interleave as two ops applied to
 * one tree.
 *
 * Every op is a pure function of its arguments. That is the property the whole
 * scheme rests on — the client applies an op locally for instant feedback and
 * the server applies the same op to its own tree, and both must land on the same
 * result. The two things that would otherwise break it are minting ids and
 * reading the clock, so ops that create nodes carry their ids and timestamps
 * rather than generating them on each side.
 *
 * This is not a CRDT. Two ops that genuinely conflict (renaming a node while
 * another client deletes its parent) still resolve last-write-wins on the loser.
 * What it buys is that non-conflicting concurrent edits stop destroying each
 * other, which was the actual failure.
 */

import {
  addChild,
  addSubtree,
  adoptFollowing,
  indent,
  insertAtDepth,
  lineageOf,
  markOpened,
  moveNode,
  outdent,
  reconcileDone,
  removeNode,
  setDone,
  setPinned,
  setText,
  toggleCollapsed,
  type NodeId,
  type SubtreeSpec,
  type Tree,
} from './tree.ts'

/**
 * Every mutation the app can make, named. Structural ops (indent, outdent,
 * adoptFollowing, insertAtDepth) are sent as themselves rather than as the
 * moveNode calls they decompose into: `adoptFollowing` is a fold over N moves,
 * and sending it whole means one broadcast instead of N, so other tabs don't
 * watch the rows migrate one at a time.
 */
export type Op =
  | { op: 'addChild'; id: NodeId; parentId: NodeId | null; text: string; at: number }
  | { op: 'addSubtree'; ids: NodeId[]; parentId: NodeId | null; nodes: SubtreeSpec[]; at: number }
  | { op: 'setText'; id: NodeId; text: string }
  | { op: 'setDone'; id: NodeId; done: boolean }
  | {
      op: 'removeNode'
      id: NodeId
      /**
       * Whether the subtree is kept in the trash, so it can be restored.
       *
       * Optional and off by default, because most `removeNode`s are not a user
       * deleting anything: backspace at the start of a line merges two rows by
       * removing one, and an empty row abandoned mid-edit removes itself. Those
       * would fill the trash with blank strings and merge artifacts, which is
       * how it stops being useful for the deletes that matter.
       *
       * A flag rather than a second op kind, because clients queue ops while
       * offline: an old build's queued `removeNode` reaching a new server must
       * still mean something, and an absent optional field does. A `discardNode`
       * op that older clients had never heard of would not.
       */
      trash?: boolean
    }
  | { op: 'moveNode'; id: NodeId; parentId: NodeId | null; index: number }
  | { op: 'indent'; id: NodeId }
  | { op: 'outdent'; id: NodeId }
  | { op: 'adoptFollowing'; id: NodeId }
  | {
      op: 'insertAtDepth'
      id: NodeId
      anchorId: NodeId
      depth: number
      side: 'before' | 'after'
      scope: NodeId | null
    }
  | { op: 'toggleCollapsed'; id: NodeId }
  | { op: 'setPinned'; id: NodeId; pinned: boolean }
  | { op: 'markOpened'; id: NodeId; at: number }

export type OpKind = Op['op']

/** Every op name, for validating an untrusted body without a second list. */
export const OP_KINDS = [
  'addChild',
  'addSubtree',
  'setText',
  'setDone',
  'removeNode',
  'moveNode',
  'indent',
  'outdent',
  'adoptFollowing',
  'insertAtDepth',
  'toggleCollapsed',
  'setPinned',
  'markOpened',
] as const satisfies readonly OpKind[]

/**
 * The projects an op disturbed, so the reconcile can skip the rest.
 *
 * Resolved against both trees because neither alone has every id: a removed
 * node is gone from the new tree, and a node the op created is absent from the
 * old one. A cross-project move is the case that yields two.
 */
function touchedRoots(before: Tree, after: Tree, ids: readonly (NodeId | null)[]): NodeId[] {
  const roots = new Set<NodeId>()
  for (const id of ids) {
    if (id === null) continue
    for (const tree of [before, after]) {
      const root = lineageOf(tree, id)[0]
      if (root) roots.add(root.id)
    }
  }
  return [...roots]
}

/**
 * Finish a structural op: the shape changed, so every parent's `done` has to be
 * re-derived from what it now contains. See `reconcileDone`.
 *
 * Scoped to the projects the op named. A `Tree` holds every project the owner
 * has, so an unscoped sweep would re-derive projects the edit never reached.
 *
 * No `completed` ids: those drive the completion animation, which belongs to the
 * user ticking something off. A parent that flips because a child was moved or
 * deleted should update quietly rather than celebrate.
 */
function structural(
  before: Tree,
  after: Tree,
  ...ids: (NodeId | null)[]
): { tree: Tree; completed: NodeId[] } {
  return { tree: reconcileDone(after, touchedRoots(before, after, ids)), completed: [] }
}

/**
 * Apply an op to a tree, returning the new tree.
 *
 * Total and non-throwing: an op naming a node that no longer exists returns the
 * tree unchanged, matching how the underlying pure ops already behave (moveNode
 * returns its input for an unknown id). That is what lets a queued op arrive
 * after the tree moved on and be a harmless no-op rather than a crash — the
 * alternative would be a client that wedges whenever it raced a delete.
 *
 * `completed` rides along from setDone: the ids of parents that flipped to done,
 * which the app uses to fire the completion animation.
 */
export function applyOp(tree: Tree, op: Op): { tree: Tree; completed: NodeId[] } {
  switch (op.op) {
    case 'addChild':
      return structural(tree, addChild(tree, op.parentId, op.text, op.id, op.at).tree, op.parentId)
    case 'addSubtree':
      return structural(tree, addSubtree(tree, op.parentId, op.nodes, op.ids, op.at).tree, op.parentId)
    case 'setText':
      return { tree: setText(tree, op.id, op.text), completed: [] }
    case 'setDone':
      return setDone(tree, op.id, op.done)
    case 'removeNode':
      // `trash` is not read here. It says what to keep on the way out, which is
      // a persistence question — the resulting tree is the same either way, and
      // this stays the pure function every client runs.
      return structural(tree, removeNode(tree, op.id), op.id)
    case 'moveNode':
      return structural(tree, moveNode(tree, op.id, op.parentId, op.index), op.id, op.parentId)
    case 'indent':
      return structural(tree, indent(tree, op.id), op.id)
    case 'outdent':
      return structural(tree, outdent(tree, op.id), op.id)
    case 'adoptFollowing':
      return structural(tree, adoptFollowing(tree, op.id), op.id)
    case 'insertAtDepth':
      return structural(
        tree,
        insertAtDepth(tree, op.id, op.anchorId, op.depth, op.side, op.scope),
        op.id,
        op.anchorId,
      )
    case 'toggleCollapsed':
      return { tree: toggleCollapsed(tree, op.id), completed: [] }
    case 'setPinned':
      return { tree: setPinned(tree, op.id, op.pinned), completed: [] }
    case 'markOpened':
      return { tree: markOpened(tree, op.id, op.at), completed: [] }
  }
}

/**
 * Validate an untrusted value into an Op, or return why it isn't one.
 *
 * Hand-rolled in the same style as the server's existing parseSubtree rather
 * than reaching for a schema library: the server has no runtime validator
 * dependency today, and the shapes are small enough that the switch reads as the
 * spec. Returned errors name the offending field so a 400 is actionable.
 */
export function parseOp(input: unknown): { op: Op } | { error: string } {
  if (typeof input !== 'object' || input === null) return { error: 'op must be an object' }
  const v = input as Record<string, unknown>
  const kind = v.op

  if (typeof kind !== 'string' || !(OP_KINDS as readonly string[]).includes(kind)) {
    return { error: `op must be one of: ${OP_KINDS.join(', ')}` }
  }

  const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : undefined)
  const num = (k: string) => (typeof v[k] === 'number' && Number.isFinite(v[k]) ? (v[k] as number) : undefined)
  const bool = (k: string) => (typeof v[k] === 'boolean' ? (v[k] as boolean) : undefined)
  // parentId and scope are genuinely nullable — null means "the root list", so
  // it has to be distinguishable from a missing field.
  const nullableStr = (k: string) =>
    v[k] === null || typeof v[k] === 'string' ? (v[k] as string | null) : undefined
  const miss = (k: string, what: string) => ({ error: `${kind}.${k} must be ${what}` })

  const id = str('id')
  // Every op except addSubtree targets a single node by id.
  if (kind !== 'addSubtree' && id === undefined) return miss('id', 'a string')

  switch (kind) {
    case 'addChild': {
      const parentId = nullableStr('parentId')
      if (parentId === undefined) return miss('parentId', 'a string or null')
      const text = str('text')
      if (text === undefined) return miss('text', 'a string')
      const at = num('at')
      if (at === undefined) return miss('at', 'a number')
      return { op: { op: 'addChild', id: id!, parentId, text, at } }
    }
    case 'addSubtree': {
      const ids = Array.isArray(v.ids) && v.ids.every((x) => typeof x === 'string') ? (v.ids as string[]) : undefined
      if (ids === undefined) return miss('ids', 'an array of strings')
      const parentId = nullableStr('parentId')
      if (parentId === undefined) return miss('parentId', 'a string or null')
      const nodes = parseSpecs(v.nodes, 'nodes')
      if (typeof nodes === 'string') return { error: nodes }
      const at = num('at')
      if (at === undefined) return miss('at', 'a number')
      return { op: { op: 'addSubtree', ids, parentId, nodes, at } }
    }
    case 'setText': {
      const text = str('text')
      if (text === undefined) return miss('text', 'a string')
      return { op: { op: 'setText', id: id!, text } }
    }
    case 'setDone': {
      const done = bool('done')
      if (done === undefined) return miss('done', 'a boolean')
      return { op: { op: 'setDone', id: id!, done } }
    }
    case 'removeNode': {
      // Absent means false. A client that has never heard of the trash sends no
      // field and gets exactly today's behaviour, which is what lets an op
      // queued by an older build stay meaningful.
      const trash = bool('trash')
      return { op: trash === undefined ? { op: 'removeNode', id: id! } : { op: 'removeNode', id: id!, trash } }
    }
    case 'moveNode': {
      const parentId = nullableStr('parentId')
      if (parentId === undefined) return miss('parentId', 'a string or null')
      const index = num('index')
      if (index === undefined) return miss('index', 'a number')
      return { op: { op: 'moveNode', id: id!, parentId, index } }
    }
    case 'indent':
      return { op: { op: 'indent', id: id! } }
    case 'outdent':
      return { op: { op: 'outdent', id: id! } }
    case 'adoptFollowing':
      return { op: { op: 'adoptFollowing', id: id! } }
    case 'insertAtDepth': {
      const anchorId = str('anchorId')
      if (anchorId === undefined) return miss('anchorId', 'a string')
      const depth = num('depth')
      if (depth === undefined) return miss('depth', 'a number')
      const side = v.side === 'before' || v.side === 'after' ? v.side : undefined
      if (side === undefined) return miss('side', "'before' or 'after'")
      const scope = nullableStr('scope')
      if (scope === undefined) return miss('scope', 'a string or null')
      return { op: { op: 'insertAtDepth', id: id!, anchorId, depth, side, scope } }
    }
    case 'toggleCollapsed':
      return { op: { op: 'toggleCollapsed', id: id! } }
    case 'setPinned': {
      const pinned = bool('pinned')
      if (pinned === undefined) return miss('pinned', 'a boolean')
      return { op: { op: 'setPinned', id: id!, pinned } }
    }
    case 'markOpened': {
      const at = num('at')
      if (at === undefined) return miss('at', 'a number')
      return { op: { op: 'markOpened', id: id!, at } }
    }
    default:
      return { error: `unknown op: ${kind}` }
  }
}

/** Validate a nested outline into SubtreeSpecs, or return the first problem. */
export function parseSpecs(val: unknown, path: string): SubtreeSpec[] | string {
  if (!Array.isArray(val)) return `${path} must be an array of nodes`
  const out: SubtreeSpec[] = []
  for (let i = 0; i < val.length; i++) {
    const n = val[i] as Record<string, unknown>
    if (typeof n !== 'object' || n === null) return `${path}[${i}] must be an object`
    if (typeof n.text !== 'string') return `${path}[${i}].text must be a string`
    const spec: SubtreeSpec = { text: n.text }
    if (n.children !== undefined) {
      const kids = parseSpecs(n.children, `${path}[${i}].children`)
      if (typeof kids === 'string') return kids
      if (kids.length) spec.children = kids
    }
    out.push(spec)
  }
  return out
}
