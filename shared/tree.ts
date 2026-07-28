/**
 * The tree, as a flat array of nodes with parent pointers.
 *
 * Flat is deliberate: this shape *is* a database table, so moving to SQLite
 * later is a loop-and-insert. Nested `children: []` would need flattening
 * first and turn every query into a tree walk.
 *
 * Depth, lineage and progress are all derived by walking — never stored, so
 * re-parenting a node can't leave a stale field behind.
 */

export type NodeId = string

export interface Node {
  id: NodeId
  /** null for a root. Each project is its own root. */
  parentId: NodeId | null
  text: string
  done: boolean
  /** sibling sequence within the same parent */
  order: number
  /** folded in place — a view concern, but persisted so it survives reload */
  collapsed: boolean
  /** favourited to the top of the projects list. Only meaningful on a root. */
  pinned?: boolean
  /** when this project was last opened, so Recents can sort by it. Root-only. */
  lastOpenedAt?: number
  createdAt: number
}

export type Tree = Node[]

// ---------------------------------------------------------------- lookups

export function byId(tree: Tree, id: NodeId): Node | undefined {
  return tree.find((n) => n.id === id)
}

/** Direct children, in sibling order. `null` gets the roots. */
export function childrenOf(tree: Tree, id: NodeId | null): Node[] {
  return tree.filter((n) => n.parentId === id).sort((a, b) => a.order - b.order)
}

export function isLeaf(tree: Tree, id: NodeId): boolean {
  return !tree.some((n) => n.parentId === id)
}

export function roots(tree: Tree): Node[] {
  return childrenOf(tree, null)
}

/**
 * Ancestors from root down to and including `id`.
 * Guards against a cycle so a corrupt tree can't hang the UI.
 */
export function lineageOf(tree: Tree, id: NodeId): Node[] {
  const out: Node[] = []
  const seen = new Set<NodeId>()
  let cur = byId(tree, id)
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    out.unshift(cur)
    cur = cur.parentId ? byId(tree, cur.parentId) : undefined
  }
  return out
}

export function depthOf(tree: Tree, id: NodeId): number {
  return lineageOf(tree, id).length - 1
}

/** Every descendant of `id`, excluding `id` itself, in depth-first order. */
export function subtreeOf(tree: Tree, id: NodeId | null): Node[] {
  const out: Node[] = []
  const walk = (pid: NodeId | null) => {
    for (const child of childrenOf(tree, pid)) {
      out.push(child)
      walk(child.id)
    }
  }
  walk(id)
  return out
}

/**
 * Every childless descendant, however deep.
 *
 * This is what the leaf filter shows. It flattens: zoomed into "Fill the
 * forms", a leaf three levels down still appears. Returning only *direct*
 * childless children would hide most of the actual work.
 */
export function leavesUnder(tree: Tree, id: NodeId | null): Node[] {
  return subtreeOf(tree, id).filter((n) => isLeaf(tree, n.id))
}

// ---------------------------------------------------------------- progress

export interface Progress {
  done: number
  total: number
  /** 0–100, rounded. 0 when there are no leaves. */
  pct: number
}

/**
 * Leaf-weighted progress: leaves done under this node ÷ total leaves under it.
 *
 * Counting *direct children* instead would be wrong — finishing 2 of 3
 * documents inside "Gather" must move the root's bar, even though "Gather"
 * itself isn't done. Every leaf in the subtree contributes.
 *
 * Consequence, and it's the right one: a branch with 20 leaves weighs 20× a
 * branch with one. That branch really is more work.
 */
export function progressOf(tree: Tree, id: NodeId): Progress {
  const leaves = leavesUnder(tree, id)
  if (leaves.length === 0) {
    const self = byId(tree, id)
    const done = self?.done ? 1 : 0
    return { done, total: 1, pct: done * 100 }
  }
  const done = leaves.filter((l) => l.done).length
  return { done, total: leaves.length, pct: Math.round((done / leaves.length) * 100) }
}

// ---------------------------------------------------------------- mutation

/**
 * Set done on a node and reconcile the tree around it.
 *
 * Down: ticking a parent completes its whole subtree (otherwise a parent could
 * read done with open children beneath it).
 * Up: a parent is done exactly when all its children are — which also *un*-does
 * ancestors when you untick something.
 *
 * Returns the ids of parents that flipped to done in this call, so the caller
 * can fire the worm animation on their children.
 */
export function setDone(tree: Tree, id: NodeId, done: boolean): { tree: Tree; completed: NodeId[] } {
  const next = tree.map((n) => ({ ...n }))
  const index = new Map(next.map((n) => [n.id, n]))
  const target = index.get(id)
  if (!target) return { tree: next, completed: [] }

  target.done = done

  // down
  const descendants = subtreeOf(next, id)
  for (const d of descendants) {
    const node = index.get(d.id)
    if (node) node.done = done
  }

  // up
  const completed: NodeId[] = []
  let parent = target.parentId ? index.get(target.parentId) : undefined
  while (parent) {
    const kids = childrenOf(next, parent.id)
    const all = kids.length > 0 && kids.every((k) => k.done)
    if (all && !parent.done) {
      parent.done = true
      completed.push(parent.id)
    } else if (!all && parent.done) {
      parent.done = false
    }
    parent = parent.parentId ? index.get(parent.parentId) : undefined
  }

  return { tree: next, completed }
}

let seq = 0
export function newId(): NodeId {
  seq += 1
  return `n${Date.now().toString(36)}${seq.toString(36)}`
}

/**
 * Append one child to `parentId`, after any existing siblings. A thin wrapper
 * over addSubtree — a single node is just a one-entry outline — so both paths
 * share the same ordering and id logic.
 *
 * `id` is optional and exists for replayed ops: the client mints the id, sends
 * it, and the server reuses it, so both sides name the new node identically.
 * Left out, a fresh one is minted as before.
 */
export function addChild(
  tree: Tree,
  parentId: NodeId | null,
  text: string,
  id?: NodeId,
  now?: number,
): { tree: Tree; id: NodeId } {
  const { tree: next, ids } = addSubtree(tree, parentId, [{ text }], id ? [id] : undefined, now)
  return { tree: next, id: ids[0] }
}

/**
 * A nested outline to graft on in one shot: each entry is a title plus optional
 * children, recursively. This is the shape a caller uses when it already knows
 * the whole subtree — building it node-by-node would be a chain of round-trips.
 */
export interface SubtreeSpec {
  text: string
  children?: SubtreeSpec[]
}

/**
 * Append a whole nested subtree under `parentId` (or as a new root when it's
 * null), assigning a fresh id to every node. Siblings keep the given order and
 * land after any existing children of the parent.
 *
 * Returns the new tree and the ids created, in the same depth-first order as
 * the spec, so the caller can address the new nodes without re-reading the tree.
 * The first id is the root of the grafted subtree — the new project's id when
 * parentId was null.
 *
 * `withIds` and `now` exist for replayed ops. Minting ids and reading the clock
 * are the only two things here that don't derive from the inputs, so a client
 * and the server applying the same op would otherwise disagree on both. Passing
 * them makes the graft a pure function of its arguments; omitting them keeps the
 * original behaviour.
 */
export function addSubtree(
  tree: Tree,
  parentId: NodeId | null,
  nodes: SubtreeSpec[],
  withIds?: NodeId[],
  now: number = Date.now(),
): { tree: Tree; ids: NodeId[] } {
  const added: Node[] = []
  const ids: NodeId[] = []
  // Ids to reuse, taken in the same depth-first order `ids` is returned in, so a
  // replayed op names every node exactly as the originating client did. Running
  // past the end (or omitting them) falls back to minting.
  let nextGiven = 0

  const walk = (pid: NodeId | null, specs: SubtreeSpec[]) => {
    // Land after every existing sibling: start past the highest order already
    // in use under this parent (whether it was there before or added just now),
    // so the graft appends even when the existing orders are sparse.
    const siblings = [...childrenOf(tree, pid), ...added.filter((n) => n.parentId === pid)]
    const start = siblings.reduce((max, n) => Math.max(max, n.order + 1), 0)
    specs.forEach((spec, i) => {
      const node: Node = {
        id: withIds?.[nextGiven++] ?? newId(),
        parentId: pid,
        text: spec.text,
        done: false,
        order: start + i,
        collapsed: false,
        createdAt: now,
      }
      added.push(node)
      ids.push(node.id)
      if (spec.children?.length) walk(node.id, spec.children)
    })
  }

  walk(parentId, nodes)
  return { tree: [...tree, ...added], ids }
}

/** Remove a node and everything under it. */
export function removeNode(tree: Tree, id: NodeId): Tree {
  const doomed = new Set([id, ...subtreeOf(tree, id).map((n) => n.id)])
  return tree.filter((n) => !doomed.has(n.id))
}

export function setText(tree: Tree, id: NodeId, text: string): Tree {
  return tree.map((n) => (n.id === id ? { ...n, text } : n))
}

export function toggleCollapsed(tree: Tree, id: NodeId): Tree {
  return tree.map((n) => (n.id === id ? { ...n, collapsed: !n.collapsed } : n))
}

export function setPinned(tree: Tree, id: NodeId, pinned: boolean): Tree {
  return tree.map((n) => (n.id === id ? { ...n, pinned } : n))
}

/** Stamp a project as just-opened, so Recents can sort by last visit. */
export function markOpened(tree: Tree, id: NodeId, at: number = Date.now()): Tree {
  return tree.map((n) => (n.id === id ? { ...n, lastOpenedAt: at } : n))
}

/**
 * Projects for the sidebar, split into two sections:
 *  - pinned: the favourited roots, in manual order.
 *  - unpinned: everything else, also in manual order.
 * Both follow the tree's own `order`; the two are disjoint — a pinned project
 * shows only under Pinned.
 */
export function projectSections(tree: Tree): { pinned: Node[]; unpinned: Node[] } {
  // `roots` is already in the tree's own manual order (by `order`). Projects are
  // a list you arrange by hand — dragging rewrites `order`, and a new project
  // appends at the end — so the sidebar keeps that order rather than re-sorting.
  const rs = roots(tree)
  const pinned = rs.filter((r) => r.pinned)
  const unpinned = rs.filter((r) => !r.pinned)
  return { pinned, unpinned }
}

/** Flat list of every project — pinned first, then the rest in manual order. */
export function projectList(tree: Tree): Node[] {
  const { pinned, unpinned } = projectSections(tree)
  return [...pinned, ...unpinned]
}

/** True when `maybeAncestor` is at or above `id` — used to block cyclic moves. */
export function isAncestor(tree: Tree, maybeAncestor: NodeId, id: NodeId): boolean {
  return lineageOf(tree, id).some((n) => n.id === maybeAncestor)
}

/**
 * Move a node to a new parent, inserted at `index` among that parent's
 * children, and renumber both affected sibling lists to a dense 0..n-1
 * sequence. This is the one primitive drag needs, and every other structural
 * move (indent, outdent) is a special case of it.
 *
 * Rejected as a no-op when the target would form a cycle — dropping a node
 * into itself or one of its own descendants. `index` is clamped to the valid
 * range, and measured against the destination list *without* the moved node,
 * so a same-parent reorder counts slots as you'd expect.
 */
export function moveNode(tree: Tree, id: NodeId, newParentId: NodeId | null, index: number): Tree {
  const node = byId(tree, id)
  if (!node) return tree
  if (newParentId === id) return tree
  if (newParentId !== null && isAncestor(tree, id, newParentId)) return tree

  const dest = childrenOf(tree, newParentId).filter((n) => n.id !== id)
  const at = Math.max(0, Math.min(index, dest.length))
  const ordered = [...dest.slice(0, at), node, ...dest.slice(at)]

  // New order for the destination list; the source list closes its gap simply
  // by being renumbered from its own remaining, still-sorted children.
  const destOrder = new Map(ordered.map((n, i) => [n.id, i]))
  const srcSurvivors = childrenOf(tree, node.parentId).filter((n) => n.id !== id)
  const srcOrder = new Map(srcSurvivors.map((n, i) => [n.id, i]))

  return tree.map((n) => {
    if (n.id === id) return { ...n, parentId: newParentId, order: destOrder.get(id)! }
    if (destOrder.has(n.id)) return { ...n, order: destOrder.get(n.id)! }
    // Only renumber the source list when it's a *different* parent; a
    // same-parent move already covered everyone through destOrder above.
    if (newParentId !== node.parentId && srcOrder.has(n.id)) return { ...n, order: srcOrder.get(n.id)! }
    return n
  })
}

/**
 * Tab: tuck a node under its preceding sibling, as that sibling's last child.
 * No-op for the first child (nothing to nest under) — outliners do the same.
 */
export function indent(tree: Tree, id: NodeId): Tree {
  const node = byId(tree, id)
  if (!node) return tree
  const siblings = childrenOf(tree, node.parentId)
  const i = siblings.findIndex((s) => s.id === id)
  if (i <= 0) return tree
  const newParent = siblings[i - 1]
  return moveNode(tree, id, newParent.id, childrenOf(tree, newParent.id).length)
}

/**
 * Shift-Tab: pop a node up a level, landing right after its old parent among
 * the grandparent's children. No-op at the root — there's nowhere higher.
 */
export function outdent(tree: Tree, id: NodeId): Tree {
  const node = byId(tree, id)
  if (!node || node.parentId === null) return tree
  const parent = byId(tree, node.parentId)
  if (!parent) return tree
  const uncles = childrenOf(tree, parent.parentId)
  const parentIndex = uncles.findIndex((u) => u.id === parent.id)
  return moveNode(tree, id, parent.parentId, parentIndex + 1)
}

/**
 * Nest every following sibling under this node, in order, appended after any
 * children it already has. The node itself stays put. This is what Shift-Tab
 * does when a row can't outdent any further: rather than escaping its level,
 * it pulls the rows below it in as its own subtree.
 */
export function adoptFollowing(tree: Tree, id: NodeId): Tree {
  const node = byId(tree, id)
  if (!node) return tree
  const siblings = childrenOf(tree, node.parentId)
  const i = siblings.findIndex((s) => s.id === id)
  if (i < 0) return tree
  const following = siblings.slice(i + 1)
  if (following.length === 0) return tree
  return following.reduce(
    (acc, sib) => moveNode(acc, sib.id, id, childrenOf(acc, id).length),
    tree,
  )
}

/**
 * Move a row one line up or down the visible list, the way dragging it would —
 * crossing into and out of other parents rather than stopping at the ends of
 * its own sibling list.
 *
 * `order` is the flattened visible rows (ids, outermost first), which the caller
 * already computes for rendering. Passing it in keeps this function honest about
 * what "one row" means: it's one row *as displayed*, so a folded subtree counts
 * as the single line it draws, and hidden rows are never landed on.
 *
 * The row carries its own subtree, so the destination is found by stepping over
 * that subtree rather than into it. Landing next to a row means becoming its
 * sibling, except when moving down onto a parent that is open — there the next
 * visible line is that parent's first child, so the row goes inside it.
 *
 * Returns the tree unchanged at either end of the list.
 */
export function moveRow(
  tree: Tree,
  id: NodeId,
  dir: 'up' | 'down',
  order: NodeId[],
): Tree {
  const node = byId(tree, id)
  if (!node) return tree
  const i = order.indexOf(id)
  if (i < 0) return tree

  const own = new Set(subtreeOf(tree, id).map((n) => n.id))
  if (dir === 'up') {
    // The nearest visible row above that isn't part of what we're carrying.
    let j = i - 1
    while (j >= 0 && own.has(order[j])) j--
    if (j < 0) return tree
    const target = byId(tree, order[j])
    if (!target) return tree
    // Land directly above that row, as its sibling.
    const sibs = childrenOf(tree, target.parentId).filter((n) => n.id !== id)
    return moveNode(tree, id, target.parentId, sibs.findIndex((n) => n.id === target.id))
  }

  // Moving down: skip our own subtree to find the next real row.
  let j = i + 1
  while (j < order.length && own.has(order[j])) j++
  if (j >= order.length) return tree
  const target = byId(tree, order[j])
  if (!target) return tree
  // An open parent's next visible line is its first child, so stepping down
  // onto it means stepping *into* it.
  const opensBelow = !target.collapsed && childrenOf(tree, target.id).length > 0
  if (opensBelow) return moveNode(tree, id, target.id, 0)
  const sibs = childrenOf(tree, target.parentId).filter((n) => n.id !== id)
  return moveNode(tree, id, target.parentId, sibs.findIndex((n) => n.id === target.id) + 1)
}

/**
 * The indent level a drop lands at, given the pointer's X and the rows framing
 * the gap. The pointer's horizontal position picks the level: rounding to the
 * nearest nesting guide. It's clamped so you can nest at most one level deeper
 * than the row above, and no shallower than the top of the current scope.
 *
 * The floor used to be the row *below* the gap, on the reasoning that a drop
 * can't be shallower than the row it lands in front of. That made an in-place
 * outdent impossible: every gap inside a parent has one of that parent's own
 * children below it, so a child could never reach depth 0 without being dragged
 * past its parent's entire subtree to the one gap with nothing underneath.
 *
 * Nothing is stranded by dropping the floor. insertAtDepth reads the depth
 * against the anchor's *lineage*, so every level from 0 up to that chain's
 * length is a real position — a shallower drop makes the row a sibling of one
 * of the anchor's ancestors and leaves the row below with the parent it already
 * had. That is the same move Shift-Tab makes.
 *
 * `guideX0` is the X of depth-0 guide, `indent` the px per level. Depths are
 * scope-relative, matching visibleRows.
 */
export function depthAtGap(
  clientX: number,
  aboveDepth: number | null,
  belowDepth: number | null,
  guideX0: number,
  indent: number,
): number {
  const maxD = aboveDepth !== null ? aboveDepth + 1 : belowDepth !== null ? belowDepth : 0
  const raw = Math.round((clientX - guideX0) / indent)
  return Math.max(0, Math.min(maxD, raw))
}

/**
 * Resolve a depth-aware drop into a concrete move. `anchorId` is the visible row
 * on the far side of the gap (the row below for a 'before' drop, the row above
 * for 'after'); `depth` is the chosen scope-relative indent from depthAtGap.
 *
 * Walking the anchor's lineage from the scope down gives the chain of possible
 * parents. A depth past the end of that chain means "nest under the anchor
 * itself"; otherwise the parent is the ancestor at that depth, and the moved
 * node slots in beside the chain member on the path.
 */
export function insertAtDepth(
  tree: Tree,
  dragging: NodeId,
  anchorId: NodeId,
  depth: number,
  side: 'before' | 'after',
  scope: NodeId | null,
): Tree {
  const full = lineageOf(tree, anchorId)
  const scopeIdx = scope ? full.findIndex((n) => n.id === scope) : -1
  const chain = full.slice(scopeIdx + 1)
  const nestUnderAnchor = depth >= chain.length
  const newParentId = nestUnderAnchor
    ? anchorId
    : depth === 0
      ? scope
      : chain[depth - 1].id
  const kids = childrenOf(tree, newParentId).filter((n) => n.id !== dragging)
  let index: number
  if (nestUnderAnchor) {
    // The gap that produced this drop sits directly *under* the anchor row, so
    // the row lands at the top of its children — that's where the indicator was
    // drawn. Appending would drop it past every existing child, somewhere the
    // pointer never was, which reads as the row jumping on release.
    index = 0
  } else {
    const onPath = chain[depth].id
    const pos = kids.findIndex((n) => n.id === onPath)
    index = side === 'before' ? pos : pos + 1
  }
  return moveNode(tree, dragging, newParentId, index)
}
