import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { exportTree, parseTree, saveTree } from './storage'
import { putTree } from './api'
import { useOutlinerSync } from './useOutlinerSync'
import { applyOp, type Op } from '@shared/ops'
import {
  addChild,
  byId,
  childrenOf,
  depthAtGap,
  insertAtDepth,
  isAncestor,
  isLeaf,
  leavesUnder,
  lineageOf,
  markOpened,
  moveNode,
  moveRow,
  newId,
  progressOf,
  projectList,
  projectSections,
  removeNode,
  roots,
  setDone,
  setPinned,
  setText,
  subtreeOf,
  toggleCollapsed,
  type NodeId,
  type Tree,
} from '@shared/tree'

// Row geometry, kept together so the indent and the nesting guides can't drift
// apart. INDENT is the px added per depth level; GUIDE_X0 is where a depth-0
// bullet's centre sits, so a guide for ancestor depth d lands at GUIDE_X0 +
// d*INDENT — directly under that ancestor's bullet.
const ROW_PAD = 6
const INDENT = 24
// The zoom control's column, left of the bullet — matching .gutter and the
// row's flex gap in CSS. Odd on purpose: the guide is an odd 1px, so an odd
// slot puts the button's centre on the same half-pixel the line already sits
// on, and the two stay visually stacked.
const GUTTER = 15
const ROW_GAP = 7
// The bullet's own size, matching .bullet in CSS. Kept here because GUIDE_X0
// depends on it: the guides are aimed at bullet *centres*, so resizing the
// bullet without moving them leaves every line sitting beside its bullet
// instead of under it. Deriving it means that can't be forgotten.
const BULLET = 18
// The guide's own width, so its centre — not its left edge — can be lined up
// with the bullet's. Left at `left: GUIDE_X0` a 1px line spans 33→34 and sits
// half a pixel right of the bullet it belongs to, which is visible at 2x.
const GUIDE_W = 1
const GUIDE_X0 = ROW_PAD + GUTTER + ROW_GAP + BULLET / 2

/** The same numbers, exported so a test can check them against index.css. */
export const GEOMETRY = { ROW_PAD, INDENT, GUTTER, ROW_GAP, BULLET, GUIDE_W, GUIDE_X0 }

// Telling a click on a bullet apart from a drag of it. DRAG_SLOP is how far the
// pointer may wander and still count as a click; past it, a mouse is dragging.
// DRAG_HOLD is the fallback for pressing without moving, and has to sit clear of
// how long a real click lasts (~80-150ms) or clicks arm drags by accident.
const DRAG_SLOP = 5
const DRAG_HOLD = 300

// Completion worm: each row wiggles for WORM_RUN, offset from the previous by
// WORM_STAGGER. On long waves the stagger tightens so the whole sweep clears
// within WORM_CAP instead of crawling — same little wave, just faster.
const WORM_RUN = 400
const WORM_STAGGER = 100
const WORM_CAP = 1000

// How long the rows below a fold take to slide to their new place, either
// direction. Short enough not to sit in the way of a second click — folding is
// something you do repeatedly while scanning a list, so the animation has to be
// over before you want the next one.
const FOLD_RUN = 160

// Closing runs in two stages rather than one: the children wipe away, and only
// then do the rows below slide up into the space they left. Overlapping the two
// puts a sliding sibling on top of a child that is still drawn, and for that
// moment the list is two sets of text in the same pixels — unreadable, which is
// worse than either stage being a little quick.
//
// Opening needs no such split: there the slide opens the gap *ahead* of the
// content arriving into it, so the two never occupy the same space.
const FOLD_STAGE = FOLD_RUN / 2

/**
 * Where a dragged node would land relative to the row under the pointer.
 * 'return' is the item's own vacated slot — drop there to put it back untouched.
 * 'into' nests as the hovered row's first child. 'before'/'after' insert in a
 * gap; there `depth` is the level the pointer picked (via its X), so the same
 * gap can mean "sibling of the row above", "child of it", or any shallower
 * ancestor level — the insertion line's indent shows which.
 */
type DropMode = 'before' | 'after' | 'into' | 'return'
interface DropTarget {
  id: NodeId
  mode: DropMode
  /** For 'before'/'after': the chosen indent level to insert at. */
  depth?: number
}

interface VisibleRow {
  id: NodeId
  depth: number
  /** leaf-filter rows are flattened — no indent, ancestry shown as a chip */
  flat: boolean
}

/**
 * Rows to draw for the current scope.
 *
 * Two independent controls compose here: scope decides how much world,
 * leafOnly decides how much detail within it. leafOnly is never global — it
 * always means "the leaves under where I'm standing".
 */
function visibleRows(
  tree: Tree,
  scope: NodeId | null,
  leafOnly: boolean,
  hideDone: boolean,
  dragId: NodeId | null,
): VisibleRow[] {
  if (leafOnly) {
    const leaves = scope
      ? leavesUnder(tree, scope)
      : roots(tree).flatMap((r) => leavesUnder(tree, r.id))
    return leaves
      .filter((l) => !(hideDone && l.done))
      .map((l) => ({ id: l.id, depth: 0, flat: true }))
  }

  const out: VisibleRow[] = []
  const walk = (parentId: NodeId | null, depth: number) => {
    for (const child of childrenOf(tree, parentId)) {
      if (hideDone && child.done) continue
      out.push({ id: child.id, depth, flat: false })
      // While dragging, the lifted item's subtree is hidden so the list closes
      // up. Its own row stays, rendered as a slim "return here" slot.
      if (child.id === dragId) continue
      if (!child.collapsed) walk(child.id, depth + 1)
    }
  }
  walk(scope, 0)
  return out
}

// A plain trash can. Monochrome, inherits currentColor.
function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden focusable="false">
      <path
        d="M6.5 2h3M3 4.2h10M4.3 4.2l.5 8.3a1 1 0 0 0 1 .95h4.4a1 1 0 0 0 1-.95l.5-8.3M6.6 6.6v4.4M9.4 6.6v4.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// The fold triangle, pointing right. Rotated 90° by CSS when the row is open.
//
// 13px on an odd 13-unit viewBox, so the shape has a true centre pixel to
// rotate about; an even box would put the pivot on a boundary and shimmer the
// glyph a half-pixel as it turns. It reads at about the weight of the 15px
// outlined checkbox despite being smaller, because it is solid and that box is
// hollow.
function FoldIcon() {
  return (
    <svg viewBox="0 0 13 13" width="13" height="13" aria-hidden focusable="false">
      <path d="M4.5 2.6 10 6.5l-5.5 3.9z" fill="currentColor" />
    </svg>
  )
}

// Three dots (vertical): the row's overflow menu, holding rename, pin and delete.
function MoreIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden focusable="false">
      <circle cx="8" cy="3.2" r="1.3" fill="currentColor" />
      <circle cx="8" cy="8" r="1.3" fill="currentColor" />
      <circle cx="8" cy="12.8" r="1.3" fill="currentColor" />
    </svg>
  )
}

export default function Outliner({ initial }: { initial: Tree }) {
  // Undo/redo is a snapshot history: the whole tree is one immutable value, so
  // a step is just the previous value. `commit` replaces the tree and records
  // the old one; undo/redo shuttle between the past and future stacks. History
  // lives only for the session — the current tree is what's persisted.
  const [history, setHistory] = useState<{ past: Tree[]; present: Tree; future: Tree[] }>({
    past: [],
    present: initial,
    future: [],
  })
  const tree = history.present

  /** Record a new tree as an undoable checkpoint. Accepts either the next tree
   *  or an updater that derives it from the current tree, so two edits fired in
   *  the same handler (rename, then add a sibling) compose off the latest state
   *  instead of racing on a stale closure value.
   *
   *  The trailing ops describe the same change for the server. The tree is
   *  applied locally so the UI never waits, and the ops are replayed server-side
   *  against whatever the shared tree is by then — that pairing is what lets
   *  this tab and a Claude on the MCP edit at once without overwriting each
   *  other. Pass them in the order they should land. */
  function commit(next: Tree | ((prev: Tree) => Tree), ...ops: Op[]) {
    setHistory((h) => {
      const value = typeof next === 'function' ? (next as (prev: Tree) => Tree)(h.present) : next
      return value === h.present ? h : { past: [...h.past, h.present], present: value, future: [] }
    })
    syncRef.current?.send(...ops)
  }
  /** Replace the tree *without* a checkpoint — for undo/redo themselves, and
   *  for changes that persist but aren't edits you'd want to undo (folding a
   *  row, stamping a project as opened). Those still send their op. */
  function setPresent(next: Tree, ...ops: Op[]) {
    setHistory((h) => ({ ...h, present: next }))
    syncRef.current?.send(...ops)
  }
  // Everything that used to call setTree still checkpoints, unchanged.
  const setTree = commit

  function undo() {
    setHistory((h) => {
      if (h.past.length === 0) return h
      const past = h.past.slice(0, -1)
      const present = h.past[h.past.length - 1]
      return { past, present, future: [h.present, ...h.future] }
    })
  }
  function redo() {
    setHistory((h) => {
      if (h.future.length === 0) return h
      const [present, ...future] = h.future
      return { past: [...h.past, h.present], present, future }
    })
  }

  const [scope, setScope] = useState<NodeId | null>(null)
  const [leafOnly, setLeafOnly] = useState(false)

  // Enter a project: scope into it and stamp it as just-opened so it rises in
  // Recents. Only roots carry the stamp, and it's written without a history
  // checkpoint — visiting a project isn't an edit you'd want to undo.
  function openProject(id: NodeId) {
    setScope(id)
    const root = lineageOf(tree, id)[0]?.id ?? id
    // The timestamp travels with the op so the server stores the same instant
    // this tab did, rather than whenever the write happened to arrive.
    const at = Date.now()
    setPresent(markOpened(tree, root, at), { op: 'markOpened', id: root, at })
  }
  const [hideDone, setHideDone] = useState(false)
  const [editing, setEditing] = useState<NodeId | null>(null)
  // The landing card whose delete is armed: its trash can has flipped to a
  // confirm ✓ with a cancel ✕ beside it. Only one card can be armed at a time.
  const [confirmDelete, setConfirmDelete] = useState<NodeId | null>(null)
  // The sidebar row whose ⋯ overflow menu is open (pin + delete), and whether
  // its Delete item has been armed into its two-step "Delete? ✓ ✕" confirm.
  const [menuOpen, setMenuOpen] = useState<NodeId | null>(null)
  const [menuArmed, setMenuArmed] = useState(false)
  /** ids currently running the worm, with their ripple index */
  const [worm, setWorm] = useState<Map<NodeId, number>>(new Map())
  const wormTimer = useRef<number | undefined>(undefined)

  // ------------------------------------------------------------ drag state
  const [dragId, setDragId] = useState<NodeId | null>(null)
  const [drop, setDrop] = useState<DropTarget | null>(null)
  // Pointer position, so the drag "card" can follow it. null when not dragging.
  // Where the ghost card sits, and the indent of the row it was lifted from.
  // Depth travels with the position so the card can never paint a frame at the
  // previous drag's indent — the two are only ever set together.
  const [ghostAt, setGhostAt] = useState<{ x: number; y: number; depth: number } | null>(null)
  // The long-press timer, and where the finger first went down, so a small
  // move cancels the press (a tap-to-zoom) but a held press starts a drag.
  const press = useRef<{ id: NodeId; x: number; y: number; timer: number } | null>(null)
  // Live refs read by the global move handler without re-subscribing.
  const treeRef = useRef(tree)
  treeRef.current = tree
  const dragIdRef = useRef<NodeId | null>(null)
  dragIdRef.current = dragId

  // Sidebar project reordering. Projects are a flat, hand-ordered list, so this
  // is a plain reorder — no nesting — kept separate from the tree's pointer drag
  // above. `sideDrag` is the project being dragged; `sideOver` is the row it's
  // hovering, with a side telling us whether to land before or after it.
  const [sideDrag, setSideDrag] = useState<NodeId | null>(null)
  const [sideOver, setSideOver] = useState<{ id: NodeId; after: boolean } | null>(null)
  // Read by dragover/drop, which can fire before React has committed the state
  // set in dragstart.
  const sideDragRef = useRef<NodeId | null>(null)
  sideDragRef.current = sideDrag
  // Set when a press turns into a drag, so the bullet's click (which fires on
  // release) doesn't also zoom. Cleared by that click.
  const justDragged = useRef(false)
  // A row Escape just backed out of. Its input blurs as it unmounts, and that
  // blur must not commit the text Escape deliberately discarded.
  const cancelled = useRef<NodeId | null>(null)

  useEffect(() => () => window.clearTimeout(wormTimer.current), [])

  // Close the sidebar ⋯ menu on any outside click or Escape, resetting its
  // armed-delete step so it never reopens mid-confirm.
  const closeMenu = () => {
    setMenuOpen(null)
    setMenuArmed(false)
  }
  useEffect(() => {
    if (menuOpen === null) return
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.row-menu, .row-more')) closeMenu()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeMenu()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  // Keep the offline cache current. The server (SQLite) is the source of truth;
  // localStorage just means a reload with the server down shows the last state
  // instead of a blank screen.
  useEffect(() => {
    saveTree(tree)
  }, [tree])

  // The server side of the same tree: ships our ops out, brings other people's
  // changes in. Held in a ref because `commit` (defined above, and called from
  // handlers all over this component) needs to reach it.
  const sync = useOutlinerSync({
    busy: editing !== null || dragId !== null,
    onAdopt: (next) => setHistory((h) => ({ ...h, present: next })),
  })
  const syncRef = useRef(sync)
  syncRef.current = sync

  // Cmd/Ctrl+Z undo, +Shift+Z (or Ctrl+Y) redo. Skipped while editing a label,
  // so the text field keeps its own native undo. Refs keep the listener stable.
  const undoRef = useRef(undo)
  undoRef.current = undo
  const redoRef = useRef(redo)
  redoRef.current = redo
  // The global key handler mounts once; these refs keep it reading current state.
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const leafOnlyRef = useRef(leafOnly)
  leafOnlyRef.current = leafOnly
  const addSiblingRef = useRef(addSibling)
  addSiblingRef.current = addSibling
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const inField =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)

      // Enter with nothing focused is a shortcut for a new task in the current
      // scope — the same as clicking "+ add a subtask", but from the keyboard.
      if (e.key === 'Enter' && !inField && scopeRef.current !== null && !leafOnlyRef.current) {
        e.preventDefault()
        addSiblingRef.current(null)
        return
      }

      if (!(e.metaKey || e.ctrlKey)) return
      const k = e.key.toLowerCase()
      if (inField) return
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault()
        undoRef.current()
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault()
        redoRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Resolve the pointer position to a drop target: which row, and which of its
  // three bands (top quarter = before, middle = into, bottom quarter = after).
  // Hovering the lifted item's own slot returns 'return' — drop there to put it
  // back untouched. Descendants aren't rendered mid-drag, so cycles can't arise.
  //
  // The middle band of a row is 'into' (nest as its first child). The top and
  // bottom quarters are insertion *gaps*; there the pointer's X picks a depth,
  // because a gap can mean several things — a gap below a deep child could drop
  // at that child's level, or outdent to any shallower ancestor level, or (if
  // the row above can take children) nest one deeper. depthAtGap works out the
  // legal range for the gap and clamps X into it.
  function hitTest(clientX: number, clientY: number): DropTarget | null {
    const dragging = dragIdRef.current
    if (!dragging) return null
    const t = treeRef.current
    const visible = rowsRef.current
    const rowEls = document.querySelectorAll<HTMLElement>('.row[data-id]')
    for (const el of rowEls) {
      const id = el.dataset.id!
      const r = el.getBoundingClientRect()
      if (clientY < r.top || clientY > r.bottom) continue
      // The item's own slot: dropping here returns it to where it started.
      if (id === dragging) return { id, mode: 'return' }
      // Belt and braces — a descendant shouldn't be rendered, but never nest
      // into one if it somehow is.
      if (isAncestor(t, dragging, id)) return null
      const rel = (clientY - r.top) / r.height
      if (rel >= 0.25 && rel <= 0.75) return { id, mode: 'into' }

      // An insertion gap. Name the rows that bound it: `above` sits just over
      // the gap, `below` just under. The top quarter is the gap above this row
      // (above = previous visible row); the bottom quarter is the gap below it.
      // The lifted item still holds a slim slot in `visible`; skip past it when
      // naming neighbours, or its old depth would wrongly bound the drop.
      const i = visible.findIndex((v) => v.id === id)
      const prev = (k: number) => {
        for (let j = k; j >= 0; j--) if (visible[j].id !== dragging) return visible[j]
        return undefined
      }
      const next = (k: number) => {
        for (let j = k; j < visible.length; j++) if (visible[j].id !== dragging) return visible[j]
        return undefined
      }
      const above = rel < 0.25 ? prev(i - 1) : prev(i)
      const below = rel < 0.25 ? next(i) : next(i + 1)
      // depthAtGap measures X from the row's own left edge, where the nesting
      // guides live (GUIDE_X0 + d*INDENT); clientX is viewport-absolute, so
      // rebase it onto the row.
      const depth = depthAtGap(
        clientX - r.left,
        above ? above.depth : null,
        below ? below.depth : null,
        GUIDE_X0,
        INDENT,
      )
      // Anchor to the row above the gap when there is one, inserting after it;
      // at the very top there's no row above, so anchor before the first row.
      return above
        ? { id: above.id, mode: 'after', depth }
        : { id: below!.id, mode: 'before', depth }
    }
    return null
  }

  /** Drop the drag state without moving anything. */
  function abortDrag() {
    setDragId(null)
    setDrop(null)
    setGhostAt(null)
    // The suppress-the-zoom flag was set when the drag began; clear it just
    // after this release so it only guards the click that immediately follows,
    // never a later tap (the click may not even land on the dragged bullet).
    window.setTimeout(() => (justDragged.current = false), 0)
  }

  function finishDrag() {
    const dragging = dragIdRef.current
    const target = drop
    abortDrag()

    if (!dragging || !target || dragging === target.id) return

    const t = treeRef.current
    const node = byId(t, target.id)
    if (!node) return

    if (target.mode === 'into') {
      // Nest as the first child; open the parent so the move is visible. That's
      // two ops — the move, then the unfold — in that order.
      let next = moveNode(t, dragging, target.id, 0)
      const ops: Op[] = [{ op: 'moveNode', id: dragging, parentId: target.id, index: 0 }]
      if (node.collapsed) {
        next = toggleCollapsed(next, target.id)
        ops.push({ op: 'toggleCollapsed', id: target.id })
      }
      setTree(next, ...ops)
    } else {
      // An insertion gap. 'before' only fires at the very top of the list
      // (nothing above to nest under); 'after' inserts below the row above the
      // gap. Both land at the depth the pointer picked.
      const side = target.mode === 'before' ? 'before' : 'after'
      const depth = target.depth ?? 0
      setTree(insertAtDepth(t, dragging, node.id, depth, side, scope), {
        op: 'insertAtDepth',
        id: dragging,
        anchorId: node.id,
        depth,
        side,
        scope,
      })
    }
  }

  // While a drag is live, track the pointer globally and end on release.
  useEffect(() => {
    if (!dragId) return
    const onMove = (e: PointerEvent) => {
      e.preventDefault()
      setDrop(hitTest(e.clientX, e.clientY))
      // Keep the depth from when the row was picked up; only the position moves.
      setGhostAt((g) => (g ? { ...g, x: e.clientX, y: e.clientY } : g))
    }
    const onUp = () => finishDrag()
    // A cancel is the system taking the pointer away mid-drag — a second finger
    // landing, the browser starting its own gesture, the window losing focus.
    // The user never released over a target, so there's no drop to honour: the
    // row stays where it was picked up.
    const onCancel = () => abortDrag()
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
    // finishDrag/hitTest read from refs, so this only needs to re-bind per drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragId, drop])

  // Bullet pointerdown: decide between a click (zoom into the row) and a drag.
  //
  // Movement is the signal. With the button already down, a pointer that has
  // travelled DRAG_SLOP is dragging — there's nothing else it could be — so the
  // drag arms immediately, with no wait at all. That's the reordering case, and
  // it's the fast one.
  //
  // The timer is only for picking a row up without moving it. It has to clear
  // the length of an ordinary click (~80-150ms) or clicks start arming drags,
  // which is what made the bullets unclickable at 120ms.
  //
  // Touch is the exception: a moving finger is usually scrolling the list, not
  // dragging a row, so there movement cancels and only the hold arms.
  function onBulletPointerDown(e: React.PointerEvent, id: NodeId) {
    if (leafOnly) return // structure isn't shown in the flattened view
    const startX = e.clientX
    const startY = e.clientY
    const touch = e.pointerType === 'touch'

    const arm = (x: number, y: number) => {
      const p = press.current
      if (p) window.clearTimeout(p.timer)
      press.current = null
      justDragged.current = true // suppress the zoom-click that ends this press
      setDragId(id)
      setDrop(null)
      setGhostAt({ x, y, depth: rowsRef.current.find((r) => r.id === id)?.depth ?? 0 })
    }

    const timer = window.setTimeout(() => {
      const p = press.current
      if (p) arm(p.x, p.y)
    }, DRAG_HOLD)
    press.current = { id, x: startX, y: startY, timer }

    const onMoved = (ev: PointerEvent) => {
      const p = press.current
      if (!p) return
      if (Math.abs(ev.clientX - p.x) <= DRAG_SLOP && Math.abs(ev.clientY - p.y) <= DRAG_SLOP) return
      // Past the slop radius. On a mouse or pen that means drag; on touch it
      // means the list is being scrolled, so give up on the press instead.
      if (touch) {
        window.clearTimeout(p.timer)
        press.current = null
      } else {
        arm(ev.clientX, ev.clientY)
      }
    }
    const cleanup = () => {
      if (press.current) {
        window.clearTimeout(press.current.timer)
        press.current = null
      }
      window.removeEventListener('pointermove', onMoved)
      window.removeEventListener('pointerup', cleanup)
    }
    window.addEventListener('pointermove', onMoved)
    window.addEventListener('pointerup', cleanup)
  }

  const scopeNode = scope ? byId(tree, scope) : undefined
  // A scope whose node was deleted would strand the view.
  useEffect(() => {
    if (scope && !byId(tree, scope)) setScope(null)
  }, [tree, scope])

  // Leaving a project that was never named and never filled in. "+ New project"
  // creates the node up front so there's something to scope into and type over,
  // which means navigating away — the wordmark, a sidebar project, a crumb —
  // would otherwise strand an empty "Untitled" you never meant to keep. Only a
  // project with no name *and* no children is swept: anything you actually put
  // in stays, named or not.
  const lastScope = useRef(scope)
  useEffect(() => {
    const left = lastScope.current
    lastScope.current = scope
    if (left === null || left === scope) return
    const node = byId(tree, left)
    if (!node || node.parentId !== null) return
    if (node.text.trim() !== '' || childrenOf(tree, left).length > 0) return
    setTree(removeNode(tree, left), { op: 'removeNode', id: left })
  }, [scope, tree])

  const rows = useMemo(
    () => visibleRows(tree, scope, leafOnly, hideDone, dragId),
    [tree, scope, leafOnly, hideDone, dragId],
  )
  // The global drag handler reads the visible list without re-subscribing.
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  // Slide the rows below a fold to their new place instead of letting them jump.
  //
  // FLIP: measure where every row sits *before* the change (First), let React
  // relayout (Last), then transform each moved row back to where it looked like
  // it was (Invert) and release that transform with a transition (Play). The
  // rows below travel their true distance in one continuous move.
  //
  // Transform, not height. Animating height reflows the document every frame,
  // and a reflow per frame across a long list is what makes the list step down
  // a row at a time rather than glide. A transform is composited: no layout, so
  // the motion is smooth however many rows are below the fold.
  //
  // Only a fold animates. A scope change, a filter toggle, a delete and a drag
  // all move rows too, and each already has its own treatment — animating them
  // here as well would replay the whole list on every navigation. The test is
  // whether some row's collapsed flag just flipped while the row stayed on
  // screen: that is a fold, and nothing else is.
  const prevTops = useRef(new Map<NodeId, number>())
  const prevTree = useRef(tree)
  // Detached copies of last frame's rows, kept so a collapse has something to
  // wipe out. By the time the effect runs React has already removed the
  // departing children from the DOM, so the originals are gone — these are
  // cloned at the end of each run, while they're still on screen.
  const prevEls = useRef(new Map<NodeId, HTMLElement>())
  // Last frame's row boxes, for parking those clones exactly where the real
  // rows were. A clone is detached, so it can't be measured itself.
  const prevHeights = useRef(new Map<NodeId, number>())
  const prevRects = useRef(new Map<NodeId, { left: number; width: number }>())

  // Layout, not passive: this runs between React's commit and the browser's
  // paint, so the inverting transform is in place before the user ever sees the
  // rows in their new positions. With a passive effect the moved list paints
  // first and the animation starts a frame late — from the wrong place, which
  // is the jump it exists to remove.
  useLayoutEffect(() => {
    const beforeTree = prevTree.current
    const first = prevTops.current
    prevTree.current = tree

    // Read the preference per run rather than once: it can change mid-session,
    // and a fold is short enough that there's no cost to asking each time.
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

    // Where everything sits now, both for this animation's Last and as the
    // First of the next one.
    const last = new Map<NodeId, number>()
    const els = new Map<NodeId, HTMLElement>()
    const heights = new Map<NodeId, number>()
    const rects = new Map<NodeId, { left: number; width: number }>()
    for (const el of document.querySelectorAll<HTMLElement>('.row[data-id]')) {
      const id = el.dataset.id!
      const box = el.getBoundingClientRect()
      last.set(id, box.top)
      heights.set(id, box.height)
      rects.set(id, { left: box.left, width: box.width })
      els.set(id, el)
    }
    prevTops.current = last

    // The rows that were on screen a moment ago but aren't now. A collapse
    // animates exactly these, and they exist only as last run's clones.
    const departing = [...prevEls.current.keys()].filter((id) => !els.has(id))
    const clones = prevEls.current
    const goneHeights = prevHeights.current
    const goneRects = prevRects.current
    // Refresh the caches for the *next* run, from the rows that are live now.
    // Each copy carries whatever the row looked like when it was last real.
    prevEls.current = new Map([...els].map(([id, el]) => [id, el.cloneNode(true) as HTMLElement]))
    prevHeights.current = heights
    prevRects.current = rects

    // Measured above the bail so the *next* fold still has its First positions
    // — the preference can be turned off between one fold and the next.
    if (still) return

    // The row whose fold caused this, if a fold caused it. It has to have been
    // on screen before and still be on screen now — a node that arrived or left
    // wholesale is a navigation, not a fold.
    const toggled = rows.find((r) => {
      const now = byId(tree, r.id)
      const then = byId(beforeTree, r.id)
      return now && then && !!now.collapsed !== !!then.collapsed && first.has(r.id)
    })
    if (!toggled) return

    const opening = !byId(tree, toggled.id)?.collapsed
    // Below the fold in the *rendered* list. Rows above it don't move, and
    // measuring rather than reasoning about depth keeps this honest when a
    // filter is also on.
    const pivot = first.get(toggled.id)!

    const moved: HTMLElement[] = []
    for (const [id, y] of last) {
      const was = first.get(id)
      // A row with no previous position is arriving — it fades rather than
      // slides, handled below.
      if (was === undefined) continue
      const dy = was - y
      // Only rows below the fold move, and a sub-pixel delta is not motion.
      if (Math.abs(dy) < 0.5 || y < pivot) continue

      const el = els.get(id)!
      // Invert: put it back where it appeared to be, with no transition, so
      // this frame paints identically to the last one.
      el.style.transition = 'none'
      el.style.transform = `translateY(${dy}px)`
      moved.push(el)
    }

    // Play on the next frame. Setting the transform and clearing it in the same
    // frame is a no-op — the browser coalesces both into the final value and
    // nothing animates. rAF is the standard way to force the intermediate state
    // to be observed.
    // Opening, the slide is the whole animation and owns the full run. Closing,
    // it is the second stage: it waits out the wipe, then covers the distance in
    // what's left.
    const slideRun = opening ? FOLD_RUN : FOLD_STAGE
    const slideWait = opening ? 0 : FOLD_STAGE

    // `linear`, not `ease`. The wipe's edge and these rows are two halves of one
    // movement, and an eased slide against a linear wipe drifts in and out of
    // step — which is exactly how the two ended up drawn over each other.
    const play = requestAnimationFrame(() => {
      for (const el of moved) {
        el.style.transition = `transform ${slideRun}ms linear ${slideWait}ms`
        el.style.transform = ''
      }
    })

    // Wipe the arriving children into view, as though a window were opening
    // over content that was already there.
    //
    // The real version of this is an accordion: wrap the subtree in one box
    // with `overflow: hidden` and animate its height 0 → natural. That can't be
    // done here — the row list is deliberately flat, because the nesting guides
    // are positioned against a flat row and the drag hit-test walks
    // `.row[data-id]` in document order. A wrapper would break both.
    //
    // So each child clips itself instead, and the delays reconstruct the one
    // edge the wrapper would have had. A single reveal line travels the height
    // of the group; a child starts uncovering when the line reaches its top and
    // finishes when the line clears its bottom. Because the rows stack flush —
    // no margins, no flex gap, all spacing is internal padding — those per-row
    // edges join into one continuous sweep.
    //
    // Clip, not opacity. A fade changes a whole row at once, so rows blink in
    // as units; a clip moves a hard edge down through the row's box, which is
    // what a window edge passing over it actually looks like.
    //
    // Both directions run the same sweep over a stack of rows; only which
    // keyframe plays, and from which end the edge starts, differ. `group` is
    // the rows in visual order with the box each occupies.
    const wiped: HTMLElement[] = []
    // Clones parked over the list during a collapse. These are appended to the
    // document, so unlike `wiped` they have to be *removed*, not just reset —
    // a leaked ghost is a dead row floating over the app.
    const ghosts: HTMLElement[] = []
    // `total` is how long the edge takes to cross the whole group: the full run
    // when opening, and only the first stage when closing, since the slide has
    // the second.
    const sweep = (
      group: Array<{ el: HTMLElement; y: number; h: number }>,
      out: boolean,
      total: number,
    ) => {
      if (!group.length) return
      const top = Math.min(...group.map((g) => g.y))
      const bottom = Math.max(...group.map((g) => g.y + g.h))
      const span = bottom - top
      for (const { el, y, h } of group) {
        // How far into the sweep the edge reaches this row's near and far side.
        // Closing runs bottom-up, so a row's distance is measured from the
        // bottom of the group instead of the top — the edge that arrives last
        // on the way open is the one that leaves first on the way closed.
        const from = out ? bottom - (y + h) : y - top
        const delay = span > 0 ? (from / span) * total : 0
        // Clamp so the last row still finishes by `total`. Rounding in the
        // fraction can push `delay + run` a hair past the group's span, and on
        // a close the ghosts are torn down at `total` exactly — a row not yet
        // fully clipped then flashes under the sliding siblings.
        const run = Math.min(span > 0 ? (h / span) * total : total, total - delay)
        // Hold the starting state through the delay: fully clipped on the way
        // in, fully drawn on the way out.
        el.style.clipPath = out ? 'inset(0 0 0 0)' : 'inset(0 0 100% 0)'
        el.style.animation = `${out ? 'wipe-out' : 'wipe-in'} ${run}ms linear ${delay}ms both`
        wiped.push(el)
      }
    }

    if (opening) {
      // Measured off the rows themselves rather than assumed from a row count:
      // rows differ in height once a label wraps.
      sweep(
        [...last.keys()]
          .filter((id) => !first.has(id))
          .map((id) => ({ el: els.get(id)!, y: last.get(id)!, h: heights.get(id)! })),
        false,
        FOLD_RUN,
      )
    } else if (departing.length) {
      // The departing rows are already out of the DOM, so their clones stand in
      // for them: parked where the originals were, wiped away, then dropped.
      // They are decoration, not content — inert, and hidden from readers, so
      // a row that has left the tree can't be tabbed to or announced.
      const board = document.querySelector('.rows')
      const parked: Array<{ el: HTMLElement; y: number; h: number }> = []
      for (const id of departing) {
        const clone = clones.get(id)
        const y = first.get(id)
        const h = goneHeights.get(id)
        const box = goneRects.get(id)
        if (!clone || !board || y === undefined || h === undefined || !box) continue
        // Not a row any more, and it must not answer to `.row` either. Dropping
        // only `data-id` is not enough: plenty of code — the hit-test, and any
        // query that walks the list — selects on the class alone, and a ghost
        // that matches is a row that has left the tree still being counted.
        // `ghost` carries the styling instead.
        clone.className = 'ghost'
        clone.removeAttribute('data-id')
        clone.setAttribute('aria-hidden', 'true')
        clone.style.pointerEvents = 'none'
        // Fixed to the viewport at the coordinates the original occupied, so it
        // sits exactly where the row was while the live list closes up beneath
        // it. Out of flow, so it displaces nothing on its way out.
        clone.style.position = 'fixed'
        clone.style.top = `${y}px`
        clone.style.left = `${box.left}px`
        clone.style.width = `${box.width}px`
        clone.style.height = `${h}px`
        clone.style.margin = '0'
        board.appendChild(clone)
        ghosts.push(clone)
        parked.push({ el: clone, y, h })
      }
      // First stage only. The rows below hold still until this finishes.
      sweep(parked, true, FOLD_STAGE)
    }

    // Hand the rows back to the stylesheet once everything has arrived. A
    // left-behind `transition: transform` would quietly animate the next thing
    // that moves this row — a drag, in particular, which has to track the
    // pointer exactly. The wipe's own styles have to go for a sharper reason:
    // the initial `inset(0 0 100% 0)` clips a row away entirely, so a row that
    // keeps it is invisible rather than merely un-animated.
    // The ghosts have no life beyond the animation — they are copies of rows
    // that no longer exist, so they go rather than get reset. Split out from
    // `settle` because a close has to drop them a stage early: they finish
    // wiping at FOLD_STAGE, and the siblings then slide up through the band
    // they occupied. Leaving them in the DOM for that second stage is what put
    // a ghost's text under a moving sibling. `.remove()` on an already-detached
    // node is a no-op, so calling this twice is safe.
    const dropGhosts = () => {
      for (const el of ghosts) el.remove()
    }

    const settle = () => {
      for (const el of moved) {
        el.style.transition = ''
        el.style.transform = ''
      }
      for (const el of wiped) {
        el.style.animation = ''
        el.style.clipPath = ''
      }
      dropGhosts()
    }

    // On a close the ghosts wipe away in the first stage; tear them down the
    // instant it ends, before the slide starts, so nothing the siblings slide
    // through still exists. Opening has no ghosts, so this timer does nothing
    // there and is left unset.
    const clearGhosts = opening ? undefined : window.setTimeout(dropGhosts, FOLD_STAGE)

    // Either direction is done at FOLD_RUN. Opening, the slide and the wipe both
    // run the whole of it. Closing, they run FOLD_STAGE each, back to back — so
    // the total is the same and one timer covers both.
    const clear = window.setTimeout(settle, FOLD_RUN)

    return () => {
      cancelAnimationFrame(play)
      window.clearTimeout(clear)
      if (clearGhosts !== undefined) window.clearTimeout(clearGhosts)
      // Unmounting mid-animation, or a second fold landing on top of this one:
      // strip the inline state so the incoming animation measures a settled row
      // rather than one frozen halfway through the last move — and so nothing
      // is left clipped out of existence.
      settle()
    }
  }, [rows, tree])

  // One progress figure for the whole view: leaves done under the current
  // scope, or across every project at "Everything".
  const scopeProgress = useMemo(() => {
    const leaves = scope ? leavesUnder(tree, scope) : roots(tree).flatMap((r) => leavesUnder(tree, r.id))
    const done = leaves.filter((l) => l.done).length
    const total = leaves.length
    return { done, total, pct: total ? Math.round((done / total) * 100) : 0 }
  }, [tree, scope])

  const openLeafCount = scopeProgress.total - scopeProgress.done

  function handleToggleDone(id: NodeId) {
    const node = byId(tree, id)
    if (!node) return
    const willComplete = !node.done
    const { tree: next, completed } = setDone(tree, id, willComplete)
    setTree(next, { op: 'setDone', id, done: willComplete })

    // The worm is the reward for *finishing* something, so it fires only when a
    // group closes out — not on every individual tick. A lone leaf that doesn't
    // complete its parent stays quiet; the payoff is saved for the moment a
    // branch actually finishes. Two ways a click finishes a branch: it ticks a
    // parent, completing that whole subtree at once, or it's the last leaf that
    // flips an ancestor to done. `completed` lists only the ancestors that
    // flipped, never the clicked node, so check the click for children too.
    // The topmost completed root is the highest flipped ancestor, else the
    // clicked parent itself. Un-checking never worms.
    const clickedIsParent = childrenOf(tree, id).length > 0
    if (willComplete && (completed.length || clickedIsParent)) {
      const topId = completed.length ? completed[completed.length - 1] : id
      const inSubtree = new Set(subtreeOf(next, topId).map((n) => n.id))
      inSubtree.add(topId)

      // Ripple in visible order; collapsed descendants aren't on screen.
      const wave = rows.filter((r) => inSubtree.has(r.id))

      // A little wave that travels down the list at a constant shape: each row
      // wiggles for WORM_RUN, staggered by WORM_STAGGER. On long waves the
      // stagger tightens so the whole thing clears within WORM_CAP rather than
      // crawling — the wave just moves faster, it doesn't change shape.
      const stagger =
        wave.length > 1
          ? Math.round(Math.min(WORM_STAGGER, Math.max(20, (WORM_CAP - WORM_RUN) / (wave.length - 1))))
          : WORM_STAGGER

      const map = new Map<NodeId, number>()
      wave.forEach((r, i) => map.set(r.id, i * stagger))
      setWorm(map)
      window.clearTimeout(wormTimer.current)
      const last = Math.max(0, ...map.values())
      wormTimer.current = window.setTimeout(() => setWorm(new Map()), last + WORM_RUN + 100)
    }
  }

  /**
   * Stop editing `id` — but only if it's still the row being edited.
   *
   * A late blur must never close a row that something else has since opened.
   * Today the input is keyed by node id, so handing editing to a *new* row
   * unmounts the old input and its blur never fires; this guard is belt to that
   * braces, and it's the only thing standing if that keying ever changes.
   * Cheap, and the alternative is losing the row you were just given.
   */
  function releaseEdit(id: NodeId) {
    setEditing((cur) => (cur === id ? null : cur))
  }

  /**
   * Whether this blur is the tail end of an edit that was already discarded.
   *
   * Escape backs a row out and then the input unmounts, firing one last blur
   * carrying the text we deliberately threw away. Committing it would resurrect
   * a removed row, or delete a row whose field was cleared. `cancelEdit` marks
   * the row; this consumes the mark, so it only ever swallows the one blur.
   */
  function wasCancelled(id: NodeId) {
    if (cancelled.current !== id) return false
    cancelled.current = null
    return true
  }

  function commitEdit(id: NodeId, text: string) {
    const trimmed = text.trim()
    // Nothing to write: either Escape already discarded this edit, or the text
    // came back identical. Committing an unchanged row would still cost an undo
    // step, so the first Cmd+Z after leaving a row would appear to do nothing.
    if (wasCancelled(id) || byId(tree, id)?.text === trimmed) {
      releaseEdit(id)
      return
    }
    // An emptied row is a deletion — matches how outliners behave.
    setTree(
      (prev) => (trimmed ? setText(prev, id, trimmed) : removeNode(prev, id)),
      trimmed ? { op: 'setText', id, text: trimmed } : { op: 'removeNode', id },
    )
    releaseEdit(id)
  }

  // Enter while editing: commit the current text and open a fresh empty sibling
  // to type into, as one tree value. The just-blurred input's commitEdit is
  // guarded (it only clears editing while still on its own row) so it can't drop
  // the new sibling, and the new input is keyed by id, so it mounts empty and
  // focused rather than reusing the old input's DOM node and its text.
  function commitAndAddSibling(id: NodeId, text: string) {
    const trimmed = text.trim()
    const parentId = byId(tree, id)?.parentId ?? scope
    const renamed = trimmed ? setText(tree, id, trimmed) : removeNode(tree, id)
    // Mint the id and timestamp here and hand both to the op, so the server
    // creates the same node rather than one of its own with a different id.
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
    setTree(next, ...ops)
    setEditing(childId)
  }

  // Deleting an empty row always drops out of edit mode rather than stepping
  // into the previous row. A held Backspace (or a leaned-on Enter) would
  // otherwise chain-delete row after row and could wipe a whole project; making
  // you re-enter to continue puts a deliberate keypress between each deletion.
  function deleteRow(id: NodeId) {
    setTree(removeNode(tree, id), { op: 'removeNode', id })
    setEditing(null)
  }

  // Up/Down while editing: hop edit focus to the previous/next row in the
  // visible, flattened order — the same list that's on screen, so it steps past
  // collapsed subtrees and skips hidden rows. Commit the current text first
  // (empty row is removed, like a blur), then land on the neighbour. At either
  // end there's nowhere to go, so it just commits and stays put.
  function moveEdit(id: NodeId, text: string, dir: 'up' | 'down') {
    const i = rows.findIndex((r) => r.id === id)
    const target = rows[dir === 'up' ? i - 1 : i + 1]
    const trimmed = text.trim()
    // Only touch the tree when the row actually changed: an emptied row is
    // removed, edited text is committed. Navigating past an unchanged row must
    // not push a no-op onto the undo history.
    if (trimmed === '') setTree((prev) => removeNode(prev, id), { op: 'removeNode', id })
    else if (trimmed !== byId(tree, id)?.text)
      setTree((prev) => setText(prev, id, trimmed), { op: 'setText', id, text: trimmed })
    if (target) setEditing(target.id)
    else releaseEdit(id)
  }

  // Escape while editing: back out without committing. A row that was never
  // given any text is a just-started node, so cancelling should remove it
  // rather than leave an empty row behind; a row with existing text just stops
  // editing and keeps what was already there.
  function cancelEdit(id: NodeId) {
    // Mark the row so the blur that follows this unmount is swallowed rather
    // than committed. See wasCancelled, which consumes the mark.
    cancelled.current = id
    if (byId(tree, id)?.text.trim() === '') setTree(removeNode(tree, id), { op: 'removeNode', id })
    setEditing(null)
  }

  // Renaming the scope title. Clearing an existing project's name keeps the
  // project — the old name stands rather than the project vanishing under you.
  // A project that never had a name is different: it only exists because you
  // just made it, so clicking away from it without typing anything backs out of
  // creating it, the same as Escape and Enter do.
  function commitTitle(id: NodeId, text: string) {
    const trimmed = text.trim()
    if (trimmed) setTree(setText(tree, id, trimmed), { op: 'setText', id, text: trimmed })
    else if (byId(tree, id)?.text.trim() === '') {
      cancelTitle(id)
      return
    }
    setEditing(null)
  }

  // Escape on the title. A brand-new project still has an empty name, so
  // cancelling removes the whole project; renaming an existing one just backs
  // out and keeps the old name.
  function cancelTitle(id: NodeId) {
    if (byId(tree, id)?.text.trim() === '') {
      setTree(removeNode(tree, id), { op: 'removeNode', id })
      setScope(null)
    }
    setEditing(null)
  }

  // Enter on the title. An empty project flows straight on into its first task,
  // since naming it and filling it are one motion. Once it has children that
  // would be a surprise — you came to rename it — so Enter just saves and steps
  // out, and a second Enter (now on an unchanged title) adds a task as before.
  // Both edits fold into one tree so the added child isn't lost, and the id is
  // taken outside setTree to stay stable under React's double-invoked updaters.
  function commitTitleAndAddTask(id: NodeId, text: string) {
    if (childrenOf(tree, id).length > 0) {
      commitTitle(id, text)
      return
    }
    const trimmed = text.trim()
    // Enter on a project that was never named backs out of creating it, the
    // same as Escape does. Committing here would leave an "Untitled" project
    // holding one blank row, which is nobody's intent.
    if (!trimmed) {
      cancelTitle(id)
      return
    }
    const named = setText(tree, id, trimmed)
    const childId = newId()
    const at = Date.now()
    const { tree: next } = addChild(named, id, '', childId, at)
    setTree(
      next,
      { op: 'setText', id, text: trimmed },
      { op: 'addChild', id: childId, parentId: id, text: '', at },
    )
    setEditing(childId)
  }

  /**
   * Tab/Shift-Tab while editing. Commit the live text first so the reparent
   * doesn't discard it, then re-nest and keep the row in edit mode.
   */
  function reindent(id: NodeId, text: string, dir: 'in' | 'out') {
    const trimmed = text.trim()
    const withText = setText(tree, id, trimmed)
    // Which structural op applies depends on where the row sits, so decide it
    // once here and use it for both the local tree and the wire — deriving it
    // twice would risk the two disagreeing.
    let structural: Op
    if (dir === 'in') {
      structural = { op: 'indent', id }
    } else {
      // Outdenting a top-level task (parent is a project root) would otherwise
      // fling it up to the root and turn it into its own project. Instead, keep
      // it in place and pull the rows below it in as its children.
      const node = byId(withText, id)
      const parent = node ? byId(withText, node.parentId ?? '') : undefined
      structural = parent && parent.parentId === null ? { op: 'adoptFollowing', id } : { op: 'outdent', id }
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
    setTree(next, ...ops)
  }

  function addSibling(afterId: NodeId | null) {
    const parentId = afterId ? (byId(tree, afterId)?.parentId ?? null) : scope
    const id = newId()
    const at = Date.now()
    const { tree: next } = addChild(tree, parentId, '', id, at)
    setTree(next, { op: 'addChild', id, parentId, text: '', at })
    setEditing(id)
  }

  // Alt+Up/Down: commit the live input text, then move the row one line through
  // the visible list — the same path dragging it with the mouse would take, in
  // and out of other parents rather than stopping at the ends of its own sibling
  // list. Both happen in one tree so neither is lost.
  //
  // moveRow needs the visible order because "one row" means one row *as drawn*:
  // a folded subtree is a single line, and hidden rows are never landed on. The
  // resulting move is read back off the tree so the server replays the same
  // destination without needing to know anything about what's on screen.
  function reorderWithText(id: NodeId, text: string, dir: 'up' | 'down') {
    const trimmed = text.trim()
    const withText = setText(tree, id, trimmed)
    const ops: Op[] = [{ op: 'setText', id, text: trimmed }]
    const next = moveRow(withText, id, dir, rowsRef.current.map((r) => r.id))
    const moved = byId(next, id)
    // At either end of the list there's nowhere to go — commit the text and stop.
    if (moved && next !== withText) {
      const index = childrenOf(next, moved.parentId).findIndex((n) => n.id === id)
      ops.push({ op: 'moveNode', id, parentId: moved.parentId, index })
    }
    setTree(next, ...ops)
  }

  // Start a new project: a fresh root, scoped into and put straight into edit
  // so you name it in place.
  function newProject() {
    const id = newId()
    const at = Date.now()
    const { tree: next } = addChild(tree, null, '', id, at)
    setTree(next, { op: 'addChild', id, parentId: null, text: '', at })
    setScope(id)
    setEditing(id)
  }

  function togglePin(id: NodeId) {
    const node = byId(tree, id)
    if (!node) return
    setTree(setPinned(tree, id, !node.pinned), { op: 'setPinned', id, pinned: !node.pinned })
    closeMenu()
  }

  // Actually delete a project and everything under it. Confirmation happens in
  // the card UI (arm the trash can, then click the ✓), so by the time this runs
  // the intent is settled.
  function deleteProject(id: NodeId) {
    if (!byId(tree, id)) return
    if (scope === id) setScope(null)
    setConfirmDelete(null)
    closeMenu()
    setTree(removeNode(tree, id), { op: 'removeNode', id })
  }

  // Land a dragged project before or after the row it was dropped on. Index is
  // measured against the full root list (minus the dragged one) so a move across
  // the Pinned/Projects split still lands where the pointer is.
  function dropProject(overId: NodeId, after: boolean) {
    const dragging = sideDragRef.current
    sideDragRef.current = null
    setSideDrag(null)
    setSideOver(null)
    if (!dragging || dragging === overId) return
    const order = roots(tree).filter((r) => r.id !== dragging)
    const pos = order.findIndex((r) => r.id === overId)
    if (pos < 0) return
    const index = after ? pos + 1 : pos
    setTree(moveNode(tree, dragging, null, index), {
      op: 'moveNode',
      id: dragging,
      parentId: null,
      index,
    })
  }

  // Download the whole tree as a JSON file — the backup / hand-off format.
  function handleExport() {
    const blob = new Blob([exportTree(tree)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ansa-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const fileInput = useRef<HTMLInputElement>(null)

  // Replace the current tree from a JSON file. Rejected outright if the file
  // isn't a valid tree, and confirmed first because it overwrites everything.
  function handleImportFile(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      const next = parseTree(String(reader.result))
      if (!next) {
        window.alert(
          "That file isn't a valid Ansa export. Pick a JSON file you exported from Ansa, or check it wasn't edited into an invalid shape.",
        )
        return
      }
      if (!window.confirm('Replace everything currently here with the imported list?')) return
      setScope(null)
      setEditing(null)
      // Import is the one change that isn't an edit to the tree but a
      // replacement of it, so it goes over the whole-tree route rather than as
      // an op. Undoable locally all the same.
      setTree(next)
      void putTree(next)
    }
    reader.readAsText(file)
  }

  const lineage = scope ? lineageOf(tree, scope) : []

  // Sidebar projects, split into Pinned and Recent (most-recently-opened first).
  const sections = projectSections(tree)

  // One sidebar project row: the name plus a ⋯ menu holding pin and delete.
  // Shared by both the Pinned and Recent lists.
  const projectRow = (node: (typeof sections.unpinned)[number]) => {
    const active = scope !== null && lineage[0]?.id === node.id
    const open = menuOpen === node.id
    const over = sideOver?.id === node.id ? (sideOver.after ? ' drop-after' : ' drop-before') : ''
    const lifting = sideDrag === node.id ? ' lifting' : ''
    return (
      <li
        key={node.id}
        className={(active ? 'here' : '') + (open ? ' menuing' : '') + over + lifting}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          // Firefox needs data set for a drag to start at all.
          e.dataTransfer.setData('text/plain', node.id)
          sideDragRef.current = node.id
          setSideDrag(node.id)
        }}
        onDragOver={(e) => {
          const dragging = sideDragRef.current
          if (!dragging || dragging === node.id) return
          e.preventDefault()
          const r = e.currentTarget.getBoundingClientRect()
          setSideOver({ id: node.id, after: e.clientY > r.top + r.height / 2 })
        }}
        onDrop={(e) => {
          e.preventDefault()
          const r = e.currentTarget.getBoundingClientRect()
          dropProject(node.id, e.clientY > r.top + r.height / 2)
        }}
        onDragEnd={() => {
          sideDragRef.current = null
          setSideDrag(null)
          setSideOver(null)
        }}
      >
        <button className="proj" onClick={() => openProject(node.id)}>
          {node.text || 'Untitled'}
        </button>
        <button
          className="row-more"
          onClick={(e) => {
            e.stopPropagation()
            setMenuArmed(false)
            setMenuOpen(open ? null : node.id)
          }}
          aria-label="Project actions"
          aria-haspopup="menu"
          aria-expanded={open}
          title="More"
        >
          <MoreIcon />
        </button>
        {open && (
          <div className="row-menu" role="menu">
            <button
              className="row-menu-item"
              role="menuitem"
              onClick={() => {
                openProject(node.id)
                setEditing(node.id)
                closeMenu()
              }}
            >
              <span>Rename</span>
            </button>
            <button className="row-menu-item" role="menuitem" onClick={() => togglePin(node.id)}>
              <span>{node.pinned ? 'Unpin' : 'Pin to top'}</span>
            </button>
            {menuArmed ? (
              // Two-step, in place — no popup. The row swaps to a confirm.
              <div className="row-menu-confirm">
                <span>Delete?</span>
                <button
                  className="rmc-yes"
                  role="menuitem"
                  onClick={() => deleteProject(node.id)}
                  aria-label="Confirm delete"
                >
                  ✓
                </button>
                <button className="rmc-no" onClick={() => setMenuArmed(false)} aria-label="Cancel delete">
                  ✕
                </button>
              </div>
            ) : (
              <button
                className="row-menu-item danger"
                role="menuitem"
                onClick={() => setMenuArmed(true)}
              >
                <span>Delete</span>
              </button>
            )}
          </div>
        )}
      </li>
    )
  }

  // The card that follows the pointer while dragging: just the grabbed item,
  // shown collapsed — never its children, even when dragging a parent.
  const dragNode = dragId ? byId(tree, dragId) : undefined

  return (
    <div className="app">
      <aside className="side">
        <button className="brand" onClick={() => setScope(null)} title="Home — all projects">
          Ansa
        </button>
        <p className="tagline">One thing at a time</p>

        {sections.pinned.length > 0 && (
          <>
            <p className="sect">Pinned</p>
            <ol className="rail projects">{sections.pinned.map(projectRow)}</ol>
          </>
        )}

        <p className="sect">Projects</p>
        <ol className="rail projects">
          {sections.unpinned.map(projectRow)}
          <li className="new-proj">
            <button onClick={newProject}>+ New project</button>
          </li>
        </ol>

        <p className="sect">View</p>
        <div className="filters">
          <label>
            <input type="checkbox" checked={leafOnly} onChange={(e) => setLeafOnly(e.target.checked)} />
            <span>
              Hide parent tasks
              <span className="fine">
                Hides anything with subtasks. Applies inside{' '}
                <span className="scopename">{scopeNode ? scopeNode.text : 'the current project'}</span>{' '}
                only.
              </span>
            </span>
          </label>
          <label>
            <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} />
            <span>
              Hide completed tasks
              <span className="fine">Completed items drop out of the list.</span>
            </span>
          </label>
        </div>

        <p className="sect">History</p>
        <div className="undo-actions">
          <button onClick={undo} disabled={history.past.length === 0} title="Undo (⌘Z)">
            ↶ Undo
          </button>
          <button onClick={redo} disabled={history.future.length === 0} title="Redo (⇧⌘Z)">
            ↷ Redo
          </button>
        </div>

        <details className="data-fold">
          <summary>Backup &amp; transfer</summary>
          <p className="fine data-note">
            Saved automatically in this browser. Export a copy only to keep it elsewhere or move to
            another machine.
          </p>
          <div className="data-actions">
            <button onClick={handleExport}>Export</button>
            <button onClick={() => fileInput.current?.click()}>Import</button>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) handleImportFile(f)
                e.target.value = '' // let the same file be re-picked later
              }}
            />
          </div>
        </details>
      </aside>

      <main className="main">
        <h1
          className={'scope-title' + (scopeNode ? ' editable' : '')}
          contentEditable={scopeNode ? editing === scopeNode.id : false}
          suppressContentEditableWarning
          ref={(el) => {
            // On entering edit, drop the caret at the end of the existing text.
            if (el && scopeNode && editing === scopeNode.id && document.activeElement !== el) {
              el.focus()
              const range = document.createRange()
              range.selectNodeContents(el)
              range.collapse(false)
              const sel = window.getSelection()
              sel?.removeAllRanges()
              sel?.addRange(range)
            }
          }}
          onClick={() => scopeNode && editing !== scopeNode.id && setEditing(scopeNode.id)}
          onBlur={(e) => {
            if (scopeNode && editing === scopeNode.id) commitTitle(scopeNode.id, e.currentTarget.textContent ?? '')
          }}
          onKeyDown={(e) => {
            if (editing !== scopeNode?.id) return
            if (e.key === 'Enter') {
              e.preventDefault()
              if (scopeNode) commitTitleAndAddTask(scopeNode.id, e.currentTarget.textContent ?? '')
            } else if (e.key === 'Escape') {
              e.preventDefault()
              if (scopeNode) {
                // Restore the display text before backing out, so a blur that
                // fires on the way can't re-commit the abandoned edit. An
                // unnamed project restores to empty, not to the placeholder.
                e.currentTarget.textContent = scopeNode.text
                cancelTitle(scopeNode.id)
              }
            }
          }}
          title={scopeNode ? 'Click to rename' : undefined}
        >
          {/* While editing, an unnamed project renders as genuinely empty. If
              the "Untitled" placeholder were the editable text, committing
              couldn't tell a name nobody typed from one somebody did — and a
              project you meant to call Untitled would be thrown away. The
              placeholder comes from CSS instead, so it's never in the text. */}
          {scopeNode ? (editing === scopeNode.id ? scopeNode.text : scopeNode.text || 'Untitled') : 'Projects'}
        </h1>

        {scope === null ? null : (
          <nav className="scope-meta crumbs" aria-label="Breadcrumb">
            <button onClick={() => setScope(null)}>Projects</button>
            {lineage.map((node) => (
              <span key={node.id} style={{ display: 'contents' }}>
                <span className="sep">›</span>
                <button className={node.id === scope ? 'cur' : ''} onClick={() => setScope(node.id)}>
                  {node.text || 'Untitled'}
                </button>
              </span>
            ))}
            {leafOnly && (
              <span className="crumb-count">
                · {openLeafCount} doable {openLeafCount === 1 ? 'thing' : 'things'}
              </span>
            )}
          </nav>
        )}

        {scope !== null && scopeProgress.total > 0 && (
          <div className={'scope-progress' + (scopeProgress.pct === 100 ? ' complete' : '')}>
            <div className="pbar">
              <i style={{ width: `${scopeProgress.pct}%` }} />
            </div>
            <span className="pct">{scopeProgress.pct}%</span>
          </div>
        )}

        {scope === null ? (
          <div className="landing">
            {projectList(tree).length === 0 && (
              <p className="empty">No projects yet — start one below.</p>
            )}
            {projectList(tree).map((p) => {
              const prog = progressOf(tree, p.id)
              const over =
                sideOver?.id === p.id ? (sideOver.after ? ' drop-after' : ' drop-before') : ''
              const lifting = sideDrag === p.id ? ' lifting' : ''
              return (
                <div
                  key={p.id}
                  className={
                    'proj-card' + (confirmDelete === p.id ? ' arming' : '') + over + lifting
                  }
                  onMouseLeave={() => setConfirmDelete((cur) => (cur === p.id ? null : cur))}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', p.id)
                    sideDragRef.current = p.id
                    setSideDrag(p.id)
                  }}
                  onDragOver={(e) => {
                    const dragging = sideDragRef.current
                    if (!dragging || dragging === p.id) return
                    e.preventDefault()
                    // Cards flow left-to-right, so the drop side is horizontal.
                    const r = e.currentTarget.getBoundingClientRect()
                    setSideOver({ id: p.id, after: e.clientX > r.left + r.width / 2 })
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    const r = e.currentTarget.getBoundingClientRect()
                    dropProject(p.id, e.clientX > r.left + r.width / 2)
                  }}
                  onDragEnd={() => {
                    sideDragRef.current = null
                    setSideDrag(null)
                    setSideOver(null)
                  }}
                >
                  {/* The card body is the zoom-in target; the delete control sits
                      over it on its own so the two clicks never collide. */}
                  <button className="proj-card-open" onClick={() => openProject(p.id)}>
                    <span className="proj-card-head">
                      <span className="proj-card-title">{p.text || 'Untitled'}</span>
                    </span>
                    <span className={'pbar' + (prog.pct === 100 ? ' complete' : '')}>
                      <i style={{ width: `${prog.pct}%` }} />
                    </span>
                    <span className="proj-card-meta">
                      {prog.pct === 100
                        ? 'All done'
                        : `${prog.done} of ${prog.total} done (${prog.pct}%)`}
                    </span>
                  </button>
                  {/* Delete confirms in place. The trash can arms on the first
                      click, flipping to a ✓ in the very same spot with a cancel
                      ✕ to its left — so a second click on the same spot (a plain
                      double-click) is a fast delete, while a deliberate ✕ backs
                      out. */}
                  {confirmDelete === p.id ? (
                    <span className="proj-card-confirm">
                      <button
                        className="proj-card-cancel"
                        onClick={() => setConfirmDelete(null)}
                        aria-label="Cancel delete"
                        title="Cancel"
                      >
                        ✕
                      </button>
                      <button
                        className="proj-card-confirm-yes"
                        onClick={() => deleteProject(p.id)}
                        aria-label={`Confirm delete ${p.text || 'this project'}`}
                        title="Delete for good"
                      >
                        ✓
                      </button>
                    </span>
                  ) : (
                    <button
                      className="proj-card-del"
                      onClick={() => setConfirmDelete(p.id)}
                      aria-label={`Delete ${p.text || 'this project'}`}
                      title="Delete project"
                    >
                      <TrashIcon />
                    </button>
                  )}
                </div>
              )
            })}
            <button className="proj-card new" onClick={newProject}>
              + New project
            </button>
          </div>
        ) : (
        <div className="rows">
          {rows.length === 0 && (
            <p className="empty">
              {leafOnly
                ? 'Nothing childless in here yet — break something down.'
                : 'Nothing here yet.'}
            </p>
          )}

          {rows.map(({ id, depth, flat }) => {
            const node = byId(tree, id)
            if (!node) return null

            // The lifted item leaves a slim slot behind (children hidden, list
            // closed up). Hovering it is the always-available "put it back" drop.
            if (dragId === id) {
              return (
                <div
                  key={id}
                  data-id={id}
                  className={'row gap-slot' + (drop?.id === id ? ' drop-return' : '')}
                  style={{ paddingLeft: ROW_PAD + depth * INDENT } as React.CSSProperties}
                  aria-hidden
                />
              )
            }

            const parent = !isLeaf(tree, id)
            // A root is a project: draw it with the parent bullet (grey halo)
            // even before it has children, so it never shows the green leaf dot.
            const bulletParent = parent || node.parentId === null
            const wormDelay = worm.get(id)

            // A check is green once its whole sibling group is done — i.e. its
            // parent is done (or it's a finished root). Otherwise a done item is
            // blue: progress, but the group isn't closed out yet.
            const groupDone = node.done && (node.parentId === null || !!byId(tree, node.parentId)?.done)

            // Ancestry between the current scope and this leaf, for the chip.
            const chip = flat
              ? lineageOf(tree, id)
                  .slice(scope ? lineageOf(tree, scope).length : 0, -1)
                  .map((a) => a.text)
                  .join(' › ')
              : ''

            const dropHere = drop?.id === id ? drop.mode : null
            // The insertion line starts under the guide of its chosen depth, so
            // its indent previews exactly where the row will land.
            const dropIndent =
              (dropHere === 'before' || dropHere === 'after') && drop?.depth !== undefined
                ? GUIDE_X0 + drop.depth * INDENT
                : null

            return (
              <div
                key={id}
                data-id={id}
                className={
                  'row' +
                  (node.done ? ' done' : '') +
                  (node.collapsed && parent && !flat ? ' collapsed' : '') +
                  (wormDelay !== undefined ? ' worm' : '') +
                  (dropHere === 'into' ? ' drop-into' : '') +
                  (dropHere === 'before' ? ' drop-before' : '') +
                  (dropHere === 'after' ? ' drop-after' : '')
                }
                style={
                  {
                    paddingLeft: flat ? ROW_PAD : ROW_PAD + depth * INDENT,
                    ...(wormDelay !== undefined ? { ['--worm-delay' as string]: `${wormDelay}ms` } : {}),
                    ...(dropIndent !== null ? { ['--drop-x' as string]: `${dropIndent}px` } : {}),
                  } as React.CSSProperties
                }
              >
                {/* Nesting guides: one vertical line per level of ancestry, so
                    you can read what belongs under what without counting indent. */}
                {!flat &&
                  depth > 0 &&
                  Array.from({ length: depth }, (_, d) => (
                    // Each line sits under the bullet of the ancestor at depth d.
                    <span
                      key={d}
                      className="guide"
                      style={{ left: GUIDE_X0 + d * INDENT - GUIDE_W / 2 }}
                      aria-hidden
                    />
                  ))}

                {/* Fold, in the twisty's old slot. Left of the bullet is where a
                    row's structural controls belong, and it lines up down the
                    column instead of drifting with the label's width. Revealed
                    on row hover, because the bullet already carries the folded
                    state at rest — this is only the control for changing it.
                    The slot is also what GUIDE_X0 measures from, so it keeps
                    its width whether or not the button is showing. */}
                {!flat && (
                  <button
                    className={
                      'fold' +
                      (parent && !node.collapsed ? ' open' : '') +
                      // A leaf's button is a spacer holding the column open. It
                      // has no glyph, so it must not paint a disc either.
                      // Named `leaf` rather than `empty` because `.empty` is
                      // the empty-list placeholder, whose padding grew this
                      // button and every leaf row with it.
                      (parent ? '' : ' leaf')
                    }
                    onClick={() =>
                      parent && setPresent(toggleCollapsed(tree, id), { op: 'toggleCollapsed', id })
                    }
                    aria-expanded={parent ? !node.collapsed : undefined}
                    aria-label={parent ? (node.collapsed ? 'Expand' : 'Collapse') : undefined}
                    tabIndex={parent ? 0 : -1}
                    title={parent ? (node.collapsed ? 'Expand' : 'Collapse') : undefined}
                  >
                    {/* A leaf keeps the empty slot — dropping the button would
                        let the row's contents slide one column left. */}
                    {parent && <FoldIcon />}
                  </button>
                )}

                {/* Clicking the bullet zooms into the row, the arrangement every
                    other outliner uses. The bullet still *shows* whether the row
                    is folded, as a ring or a disc — the state and the control
                    that changes it are simply different objects, since the
                    triangle in the gutter now owns folding. Holding it drags. */}
                <button
                  className={
                    'bullet ' +
                    (bulletParent ? 'parent' : 'leaf') +
                    (node.collapsed && bulletParent && !flat ? ' collapsed' : '') +
                    // The flattened view has no structure to zoom into or drag
                    // within, so there the bullet is decoration and says so.
                    (flat ? ' inert' : '')
                  }
                  onPointerDown={flat ? undefined : (e) => onBulletPointerDown(e, id)}
                  onClick={() => {
                    // A press that became a drag must not also zoom.
                    if (justDragged.current) {
                      justDragged.current = false
                      return
                    }
                    if (flat) return
                    setScope(id)
                  }}
                  aria-label={flat ? undefined : `Zoom into ${node.text}`}
                  tabIndex={flat ? -1 : 0}
                  title={flat ? undefined : 'Zoom in — or hold to drag'}
                />

                <button
                  className={'check' + (groupDone ? ' group-done' : '')}
                  role="checkbox"
                  aria-checked={node.done}
                  aria-label={node.text}
                  onClick={() => handleToggleDone(id)}
                />

                <div className="body">
                  {editing === id ? (
                    <input
                      // Key by node id so moving edit focus to a new row (e.g.
                      // Enter → new sibling) remounts a fresh input: without it
                      // React reuses the same DOM node and keeps the prior row's
                      // typed text, since defaultValue only applies on mount.
                      key={id}
                      className="label-input"
                      autoFocus
                      defaultValue={node.text}
                      onBlur={(e) => commitEdit(id, e.target.value)}
                      onKeyDown={(e) => {
                        const empty = e.currentTarget.value.trim() === ''
                        if (e.key === 'Enter') {
                          // Enter on an empty row deletes it and drops out of edit
                          // mode, rather than spawning yet another empty sibling.
                          if (empty) deleteRow(id)
                          else commitAndAddSibling(id, e.currentTarget.value)
                        } else if (e.key === 'Backspace' && empty) {
                          // Backspace on an empty row removes it but drops out of
                          // edit mode rather than stepping into the previous row,
                          // so a held key can't chain-delete the whole project.
                          e.preventDefault()
                          deleteRow(id)
                        } else if (e.key === 'Escape') {
                          cancelEdit(id)
                        } else if (e.key === 'Tab' && !leafOnly) {
                          // Reparenting is incoherent in the flattened leaf view.
                          e.preventDefault()
                          reindent(id, e.currentTarget.value, e.shiftKey ? 'out' : 'in')
                        } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                          // Reorder within siblings, keeping the row in edit mode.
                          // Commit the live text in the same update so the reorder
                          // doesn't drop it.
                          e.preventDefault()
                          reorderWithText(id, e.currentTarget.value, e.key === 'ArrowUp' ? 'up' : 'down')
                        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                          // Plain Up/Down hops edit focus between rows. Rows are
                          // single-line, so the arrows have no in-line caret job
                          // to preempt.
                          e.preventDefault()
                          moveEdit(id, e.currentTarget.value, e.key === 'ArrowUp' ? 'up' : 'down')
                        }
                      }}
                    />
                  ) : (
                    <div className="label" onClick={() => setEditing(id)}>
                      <span className="label-text" title={node.text || undefined}>
                        {node.text || <span style={{ color: 'var(--ink-ghost)' }}>Untitled</span>}
                      </span>
                      {chip && <span className="chip">{chip}</span>}
                    </div>
                  )}
                </div>

                {/* The flattened leaf view has no gutter, and its bullets are
                    inert — no structure to zoom into or fold — so zoom falls
                    back to an explicit control at the right edge. */}
                {flat && (
                  <button
                    className="zoom trailing"
                    onClick={() => setScope(id)}
                    aria-label={`Zoom into ${node.text}`}
                    title="Zoom in"
                  >
                    ›
                  </button>
                )}
              </div>
            )
          })}

          {!leafOnly && (
            <button className="add" onClick={() => addSibling(null)}>
              + add a subtask
            </button>
          )}
        </div>
        )}
      </main>

      {dragNode && ghostAt && (
        <div
          className="drag-ghost"
          // Carry the indent the row had when it was picked up, so the card sits
          // where the row sat instead of flush against the pointer.
          style={
            {
              left: ghostAt.x + 12 + ghostAt.depth * INDENT,
              top: ghostAt.y + 8,
            } as React.CSSProperties
          }
          aria-hidden
        >
          {/* The ghost is the row you're holding, so it wears the same mark the
              row does — a folded parent has to keep its disc, or picking it up
              would look like it quietly unfolded. */}
          <span
            className={
              'bullet ' +
              (isLeaf(tree, dragNode.id)
                ? 'leaf'
                : 'parent' + (dragNode.collapsed ? ' collapsed' : ''))
            }
          />
          <span className="ghost-label">{dragNode.text || 'Untitled'}</span>
        </div>
      )}
    </div>
  )
}
