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
  /** favourited onto the home screen's Pinned shelf. Set on any node, not just
   * a root — `projectSections` is what filters roots, not this flag. */
  pinned?: boolean
  /** manual position on the Pinned shelf. Absent until the pin is dragged, and
   * absent sorts last — see `pinnedItems`. */
  pinOrder?: number
  /** when this project was last opened, so Recents can sort by it. Root-only. */
  lastOpenedAt?: number
  createdAt: number
}

export type Tree = Node[]

// ------------------------------------------------------------ fingerprint

/**
 * A short hash of everything in the tree that sync has to agree on.
 *
 * The server stamps every broadcast with the fingerprint of its tree after the
 * write, and a client that is otherwise idle compares it against its own. A
 * mismatch means the two have drifted — an op applied in a different order on
 * each side, a rejected edit still on screen, an applier that disagrees between
 * Swift and TypeScript — and the client refetches. This is what lets the
 * broadcast carry one op instead of the whole tree without giving up the
 * guarantee that every client ends up holding what the server holds.
 *
 * Timestamps are left out on purpose. `createdAt` and `lastOpenedAt` are
 * floating-point on the wire, and getting two languages to print the same
 * decimal for the same double is a problem this does not need to have. Nothing
 * sync cares about depends on them: a node's creation time never changes, and
 * a stale `lastOpenedAt` costs a Recents order, not a wrong tree.
 *
 * Mirrored by `TreeOps.fingerprint` in AnsaCore. The two must produce the same
 * string for the same tree, and a fixture test on each side checks that.
 */
export function fingerprint(tree: Tree): string {
  const rows = tree.map((n) =>
    [
      n.id,
      n.parentId ?? '',
      n.text,
      n.done ? '1' : '0',
      String(n.order),
      n.collapsed ? '1' : '0',
      n.pinned ? '1' : '0',
      n.pinOrder === undefined || n.pinOrder === null ? '' : String(n.pinOrder),
    ].join('\u001f'),
  )
  // Storage order is not meaningful, so sort. Ids lead each row and are unique,
  // which makes the order total. The default comparator orders by UTF-16 unit,
  // which is what the Swift side sorts by too.
  rows.sort()
  // FNV-1a, 32-bit. Not cryptographic and does not need to be: the question is
  // "did these two trees come out the same", not "could someone forge one".
  const bytes = new TextEncoder().encode(rows.join('\u001e'))
  let h = 0x811c9dc5
  for (const b of bytes) {
    h ^= b
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// ------------------------------------------------------------- validation

/**
 * The most text one task can hold, in UTF-16 units (JS string length).
 *
 * A task is meant to be small; anything bigger is a project and belongs split
 * into children. The longest title in real use is under a hundred characters,
 * so this leaves room without letting a row become a document. Both clients
 * clamp before committing so a user never sees a rejection, and every server
 * entry point checks so a client that skipped the clamp is told at the edge.
 */
export const MAX_TEXT_LENGTH = 200

/** `text` cut to the limit, for a client to apply before committing. */
export function clampText(text: string): string {
  return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text
}

/** Why `text` is unusable as a task's text, or null when it's fine. */
export function invalidText(text: unknown): string | null {
  if (typeof text !== 'string') return 'must be a string'
  if (text.length > MAX_TEXT_LENGTH) {
    return `is too long (${text.length} characters; the limit is ${MAX_TEXT_LENGTH})`
  }
  return null
}

/**
 * True when `value` is shaped like a Node. Unknown extra keys are tolerated —
 * an older or newer client's field shouldn't make a tree unreadable.
 *
 * The optional fields are checked when present rather than ignored: `pinned`
 * and `lastOpenedAt` are read straight into sorting and rendering, so a string
 * where a number belongs surfaces far from here, as a mis-sorted project list
 * rather than a rejected write.
 */
export function isNode(value: unknown): value is Node {
  if (typeof value !== 'object' || value === null) return false
  const n = value as Record<string, unknown>
  return (
    typeof n.id === 'string' &&
    (n.parentId === null || typeof n.parentId === 'string') &&
    invalidText(n.text) === null &&
    typeof n.done === 'boolean' &&
    typeof n.order === 'number' &&
    Number.isFinite(n.order) &&
    typeof n.collapsed === 'boolean' &&
    typeof n.createdAt === 'number' &&
    Number.isFinite(n.createdAt) &&
    (n.pinned === undefined || typeof n.pinned === 'boolean') &&
    (n.lastOpenedAt === undefined ||
      (typeof n.lastOpenedAt === 'number' && Number.isFinite(n.lastOpenedAt)))
  )
}

/**
 * Check an already-parsed value is a usable Tree, naming the first problem.
 *
 * Per-node shape isn't enough — the three referential rules below are what keep
 * the walks in this file terminating and total:
 *
 *  - unique ids, or byId returns one node while removeNode drops two;
 *  - every parentId resolves, or a whole branch is orphaned out of every view
 *    while still occupying the table;
 *  - no parent cycles, which is the one that actually hangs: lineageOf,
 *    subtreeOf and depthOf all walk parent pointers with no visited set, so a
 *    cycle is an infinite loop rather than a wrong answer.
 *
 * Returns null when the tree is fine, so callers read `const bad = invalidTree(t)`.
 */
export function invalidTree(value: unknown): string | null {
  if (!Array.isArray(value)) return 'tree must be an array of nodes'
  const bad = value.findIndex((n) => !isNode(n))
  if (bad !== -1) return `tree[${bad}] is not a valid node`

  const tree = value as Tree
  const ids = new Set<NodeId>()
  for (const n of tree) {
    if (ids.has(n.id)) return `duplicate node id: ${n.id}`
    ids.add(n.id)
  }
  for (const n of tree) {
    if (n.parentId !== null && !ids.has(n.parentId)) {
      return `node ${n.id} has a parentId that doesn't exist: ${n.parentId}`
    }
  }

  // Walk each node to its root. Nodes already proven to reach a root are
  // memoised, so this stays linear over the whole tree rather than quadratic
  // down a deep chain.
  const rooted = new Set<NodeId>()
  const parents = new Map(tree.map((n) => [n.id, n.parentId]))
  for (const start of tree) {
    const path: NodeId[] = []
    const seen = new Set<NodeId>()
    let cur: NodeId | null = start.id
    while (cur !== null && !rooted.has(cur)) {
      if (seen.has(cur)) return `node ${cur} is its own ancestor`
      seen.add(cur)
      path.push(cur)
      cur = parents.get(cur) ?? null
    }
    for (const id of path) rooted.add(id)
  }
  return null
}

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
 * can fire the ripple animation on their children.
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

/**
 * Re-derive every parent's `done` from its children, bottom-up.
 *
 * A parent is done exactly when all its children are — it is a summary of its
 * contents and holds no completion of its own. Leaves are left alone; their
 * `done` is the only place the fact actually lives.
 *
 * Structural ops need this because they change *what* a parent contains without
 * going through `setDone`. Adding a done child to an open leaf should complete
 * it; deleting a parent's last unfinished child should complete it; moving a
 * child out reconciles the parent it left as well as the one it joined. Wiring
 * each op to the parents it touched would work, but every op that reparents —
 * move, indent, outdent, adoptFollowing, insertAtDepth — would have to get it
 * right separately, and a new one could forget. Sweeping the tree cannot.
 *
 * A leaf that gains its first child stops being done unless that child is:
 * adding a subtask to a finished task means it isn't finished any more. The
 * alternative, pushing the parent's done onto the new child, would mark work
 * complete that nobody has done.
 *
 * `rootIds` narrows the sweep to those projects. A `Tree` is every project the
 * owner has, not one of them, so an unscoped call re-derives projects the op
 * never touched — harmless but pointless work on every edit.
 */
export function reconcileDone(tree: Tree, rootIds?: readonly NodeId[]): Tree {
  const next = tree.map((n) => ({ ...n }))
  const kids = new Map<NodeId, Node[]>()
  for (const n of next) {
    if (n.parentId === null) continue
    const list = kids.get(n.parentId)
    if (list) list.push(n)
    else kids.set(n.parentId, [n])
  }

  // Deepest first, so a parent is decided only after its own children have
  // been. Depth is computed once per node rather than by walking lineages,
  // which would be quadratic on a deep tree.
  const depth = new Map<NodeId, number>()
  const index = new Map(next.map((n) => [n.id, n]))
  const depthOfNode = (n: Node): number => {
    const cached = depth.get(n.id)
    if (cached !== undefined) return cached
    // Guard a cycle the same way lineageOf does: a corrupt tree must not hang.
    depth.set(n.id, 0)
    const parent = n.parentId ? index.get(n.parentId) : undefined
    const d = parent ? depthOfNode(parent) + 1 : 0
    depth.set(n.id, d)
    return d
  }

  // Only the projects the caller names, when it names any. An op touches one
  // project (a cross-project move touches two), and every other project's
  // children are exactly as they were — re-deriving them cannot change an
  // answer. Omitting the scope sweeps everything, which is what a repair pass
  // over a tree of unknown provenance wants.
  const scope = rootIds && new Set(rootIds)
  const inScope = (n: Node): boolean => {
    if (!scope) return true
    let cur: Node | undefined = n
    const seen = new Set<NodeId>()
    while (cur && !seen.has(cur.id)) {
      if (scope.has(cur.id)) return true
      seen.add(cur.id)
      cur = cur.parentId ? index.get(cur.parentId) : undefined
    }
    return false
  }

  const parents = next.filter((n) => kids.has(n.id) && inScope(n))
  parents.sort((a, b) => depthOfNode(b) - depthOfNode(a))
  for (const parent of parents) {
    parent.done = kids.get(parent.id)!.every((k) => k.done)
  }

  return next
}

/**
 * Mint a node id.
 *
 * Node ids are unique across the whole `nodes` table — `ownerId` is not part of
 * the primary key — so this has to be unique globally, not just within one
 * tree. Two things ruled out the obvious cheaper schemes:
 *
 * A timestamp plus a process-local counter (what this was) collides outright
 * whenever two clients mint in the same millisecond, since each starts counting
 * from zero. Two tabs and the MCP server are three such processes.
 *
 * `Math.random().toString(36).slice(2, 10)` is ~41 bits, which puts a first
 * collision in reach around tens of thousands of rows.
 *
 * A v4 UUID is 122 bits from a cryptographic source, which retires the question
 * rather than moving it. Ids already in the database keep working — nothing
 * parses them, they only have to be distinct.
 */
export function newId(): NodeId {
  return crypto.randomUUID()
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

export function setPinOrder(tree: Tree, id: NodeId, order: number): Tree {
  return tree.map((n) => (n.id === id ? { ...n, pinOrder: order } : n))
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


/**
 * The Pinned shelf: every pinned node, projects and tasks in one order.
 *
 * One list because the shelf is arranged by hand — a grouping the machine
 * imposes would fight the order the user set. A root carries an empty trail,
 * which is also what says it is a project.
 *
 * `pinOrder` is the arrangement; the depth-then-order sort behind it is what an
 * unarranged shelf falls back to. Absent sorts last, so a pin that has never
 * been dragged sits after the ones that have rather than jumping to the top,
 * and shipping this needs no backfill.
 */
export function pinnedItems(tree: Tree): { node: Node; trail: Node[] }[] {
  return tree
    .filter((n) => n.pinned)
    .map((node) => ({ node, trail: lineageOf(tree, node.id).slice(0, -1) }))
    .sort((a, b) => {
      const ao = a.node.pinOrder ?? Infinity
      const bo = b.node.pinOrder ?? Infinity
      if (ao !== bo) return ao - bo
      return a.trail.length - b.trail.length || a.node.order - b.node.order
    })
}


/** Flat list of every project — pinned first, then the rest in manual order. */
export function projectList(tree: Tree): Node[] {
  const { pinned, unpinned } = projectSections(tree)
  return [...pinned, ...unpinned]
}

/**
 * Where to land on open: the project last worked in, or null for the home list.
 *
 * The point is not to greet you with a wall of every project you have ever
 * started. Landing where you left off means the first thing on screen is the
 * thing you were already doing, which is most of what a "what should I do now"
 * view has to get right.
 *
 * Derived from `lastOpenedAt` in the tree rather than from local storage, so it
 * follows the account rather than the device: pick the phone up after working at
 * the desk and it opens the same project. It also needs no new state to keep in
 * step — `markOpened` already stamps this on every visit.
 *
 * Root-level on purpose. It restores the project, not a deep sub-scope, because
 * the project is the unit you navigate by and a stale deep scope is more
 * disorienting than helpful. Deliberately the whole rule for now: change this
 * one function to change where every client lands, and nothing else moves.
 */
export function resumeScope(tree: Tree): NodeId | null {
  let best: Node | null = null
  for (const r of roots(tree)) {
    if (r.lastOpenedAt === undefined) continue
    if (best === null || r.lastOpenedAt > best.lastOpenedAt!) best = r
  }
  return best?.id ?? null
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
