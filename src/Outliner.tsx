import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { exportTree, parseTree, saveTree } from './storage'
import { putTree } from './api'
import { dropTargetAt, measureRows, type DropTarget } from './dropTarget'
import {
  commitAndAddSiblingEdit,
  commitEditEdit,
  reindentEdit,
  reorderWithTextEdit,
  titleAndFirstTaskEdit,
  type Edit,
} from './edits'
import { useFoldAnimation } from './useFoldAnimation'
import { useOutlinerSync } from './useOutlinerSync'
import { useRipple } from './useRipple'
import WhoAmIPanel from './WhoAmI'
import SyncToast from './SyncToast'
import type { Op } from '@shared/ops'
import {
  addChild,
  byId,
  childrenOf,
  insertAtDepth,
  isLeaf,
  leavesUnder,
  lineageOf,
  markOpened,
  moveNode,
  newId,
  progressOf,
  projectList,
  projectSections,
  removeNode,
  resumeScope,
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
// The bullet starts the row, so its centre is one padding plus half a bullet
// from the left edge. There used to be a 15px gutter here holding the fold
// triangle; folding moved onto the bullet itself and the column went with it.
const GUIDE_X0 = ROW_PAD + BULLET / 2

/** The same numbers, exported so a test can check them against index.css. */
export const GEOMETRY = { ROW_PAD, INDENT, ROW_GAP, BULLET, GUIDE_W, GUIDE_X0 }

// Telling a click on a bullet apart from a drag of it. DRAG_SLOP is how far the
// pointer may wander and still count as a click; past it, a mouse is dragging.
// DRAG_HOLD is the fallback for pressing without moving, and has to sit clear of
// how long a real click lasts (~80-150ms) or clicks arm drags by accident.
const DRAG_SLOP = 5
const DRAG_HOLD = 300

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

  // Land where the last session left off rather than on the full project list.
  // The rule itself lives in shared/tree.ts, so every client resumes alike and
  // changing where you land is one pure function away.
  const [scope, setScopeRaw] = useState<NodeId | null>(() => resumeScope(initial))
  // True until the user navigates themselves. `initial` is the localStorage
  // cache, which on a new device is empty and on an old one can be behind, so
  // the first resume is a guess made from a tree we don't trust yet. When the
  // server's real tree lands we take its answer instead — but only while this
  // is still untouched, or adopting would yank you out of a project you had
  // already opened by hand.
  const autoScope = useRef(true)

  // Navigate. Every user-initiated scope change goes through here rather than
  // touching the setter, so that "the user has chosen where they are" is
  // recorded in one place instead of at a dozen call sites that a new one could
  // forget to join. The resume path deliberately doesn't use this.
  const setScope = useCallback((id: NodeId | null) => {
    autoScope.current = false
    setScopeRaw(id)
  }, [])

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
  // The completion wave, fired when finishing a branch. Owns its own timer.
  const ripple = useRipple()

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
    onAdopt: (next) => {
      setHistory((h) => ({ ...h, present: next }))
      // Re-resume against the authoritative tree. The mount-time guess came
      // from the localStorage cache, which is empty on a new device and can be
      // behind on an old one — this is the first tree worth trusting. Skipped
      // once the user has navigated, so it never moves the view under them.
      if (autoScope.current) setScopeRaw(resumeScope(next))
    },
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
  // Resolve the pointer to a drop target. The measuring stays here (it reads the
  // live DOM); the decision is in dropTarget.ts, where it can be tested.
  function hitTest(clientX: number, clientY: number): DropTarget | null {
    const dragging = dragIdRef.current
    if (!dragging) return null
    return dropTargetAt(
      clientX,
      clientY,
      dragging,
      treeRef.current,
      rowsRef.current,
      measureRows(),
      GUIDE_X0,
      INDENT,
    )
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
  useFoldAnimation(tree, rows)

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

    // The ripple is the reward for *finishing* something, so it fires only when a
    // group closes out — not on every individual tick. A lone leaf that doesn't
    // complete its parent stays quiet; the payoff is saved for the moment a
    // branch actually finishes. Two ways a click finishes a branch: it ticks a
    // parent, completing that whole subtree at once, or it's the last leaf that
    // flips an ancestor to done. `completed` lists only the ancestors that
    // flipped, never the clicked node, so check the click for children too.
    // The topmost completed root is the highest flipped ancestor, else the
    // clicked parent itself. Un-checking never ripples.
    const clickedIsParent = childrenOf(tree, id).length > 0
    if (willComplete && (completed.length || clickedIsParent)) {
      const topId = completed.length ? completed[completed.length - 1] : id
      const inSubtree = new Set(subtreeOf(next, topId).map((n) => n.id))
      inSubtree.add(topId)
      // Ripple in visible order; collapsed descendants aren't on screen.
      ripple.start(rows.filter((r) => inSubtree.has(r.id)).map((r) => r.id))
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

  /** Apply a computed edit: check it in as one tree, then place the caret. */
  function applyEdit(edit: Edit) {
    if (edit.ops.length) setTree(edit.tree, ...edit.ops)
    setEditing(edit.focus)
  }

  function commitEdit(id: NodeId, text: string) {
    // Escape already discarded this edit — swallow the trailing blur.
    if (wasCancelled(id)) {
      releaseEdit(id)
      return
    }
    const edit = commitEditEdit(tree, id, text, null)
    if (edit.ops.length) setTree(edit.tree, ...edit.ops)
    // Unlike the other keys this only *releases* the row: a late blur must never
    // close a row something else has since opened. See releaseEdit.
    releaseEdit(id)
  }

  // Enter while editing: commit the current text and open a fresh empty sibling
  // to type into, as one tree value. The just-blurred input's commitEdit is
  // guarded (it only clears editing while still on its own row) so it can't drop
  // the new sibling, and the new input is keyed by id, so it mounts empty and
  // focused rather than reusing the old input's DOM node and its text.
  function commitAndAddSibling(id: NodeId, text: string) {
    applyEdit(commitAndAddSiblingEdit(tree, id, text, scope))
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
    const edit = commitEditEdit(tree, id, text, target ? target.id : null)
    if (edit.ops.length) setTree(edit.tree, ...edit.ops)
    // At either end there's nowhere to go, so it just commits and stays put.
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
    const edit = titleAndFirstTaskEdit(tree, id, text)
    if (edit) {
      applyEdit(edit)
      return
    }
    // Either the project already has children — you came to rename it, so Enter
    // just saves and steps out — or it was never named, and Enter backs out of
    // creating it the same as Escape does. commitTitle handles both.
    if (!text.trim()) cancelTitle(id)
    else commitTitle(id, text)
  }

  /**
   * Tab/Shift-Tab while editing. Commit the live text first so the reparent
   * doesn't discard it, then re-nest and keep the row in edit mode.
   */
  function reindent(id: NodeId, text: string, dir: 'in' | 'out') {
    applyEdit(reindentEdit(tree, id, text, dir))
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
    const order = rowsRef.current.map((r) => r.id)
    applyEdit(reorderWithTextEdit(tree, id, text, dir, order))
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
      <SyncToast live={sync.live} rejected={sync.rejected} onDismissRejected={sync.clearRejected} />
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
          <WhoAmIPanel />
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
            const rippleDelay = ripple.delayFor(id)

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
                  (rippleDelay !== undefined ? ' ripple' : '') +
                  (dropHere === 'into' ? ' drop-into' : '') +
                  (dropHere === 'before' ? ' drop-before' : '') +
                  (dropHere === 'after' ? ' drop-after' : '')
                }
                style={
                  {
                    paddingLeft: flat ? ROW_PAD : ROW_PAD + depth * INDENT,
                    ...(rippleDelay !== undefined ? { ['--ripple-delay' as string]: `${rippleDelay}ms` } : {}),
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

                {/* Clicking the bullet folds the row, matching the phone, where
                    tapping the bullet is the whole interaction. The bullet
                    already *shows* the folded state as a ring or a disc, so the
                    state and the control that changes it are now one object —
                    which is what the gutter triangle failed at: it sat on top of
                    the nesting guides and read as clutter. Zoom moved to the
                    arrow at the row's right edge. Holding the bullet drags. */}
                <button
                  className={
                    'bullet ' +
                    (bulletParent ? 'parent' : 'leaf') +
                    (node.collapsed && bulletParent && !flat ? ' collapsed' : '') +
                    // Whether a *click* does anything, which is not the same as
                    // whether the bullet draws a ring: a top-level childless row
                    // is `parent` for the ring and folds nothing. CSS needs the
                    // distinction for the cursor, and only the TSX knows it.
                    (!flat && parent ? ' folds' : '') +
                    // The flattened view has no structure to fold or drag
                    // within, so there the bullet is decoration and says so.
                    (flat ? ' inert' : '')
                  }
                  onPointerDown={flat ? undefined : (e) => onBulletPointerDown(e, id)}
                  onClick={() => {
                    // A press that became a drag must not also fold.
                    if (justDragged.current) {
                      justDragged.current = false
                      return
                    }
                    if (flat || !parent) return
                    setPresent(toggleCollapsed(tree, id), { op: 'toggleCollapsed', id })
                  }}
                  aria-expanded={!flat && parent ? !node.collapsed : undefined}
                  aria-label={
                    !flat && parent ? (node.collapsed ? 'Expand' : 'Collapse') : undefined
                  }
                  // A leaf's bullet is still a drag handle, but it has no fold
                  // to reach by keyboard and nothing to announce, so it stays
                  // out of the tab order the way the old leaf spacer did.
                  tabIndex={!flat && parent ? 0 : -1}
                  title={
                    !flat && parent
                      ? (node.collapsed ? 'Expand' : 'Collapse') + ' — or hold to drag'
                      : !flat
                        ? 'Hold to drag'
                        : undefined
                  }
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
                        if ((e.metaKey || e.ctrlKey) && (e.key === 'd' || e.key === 'D')) {
                          // Cmd/Ctrl+D toggles the edited row's done state without
                          // leaving edit mode, so you can tick a task off as you
                          // pass over it. preventDefault stops the browser's
                          // bookmark shortcut. Only the done flag flips — the live
                          // input keeps whatever's typed but not yet committed.
                          e.preventDefault()
                          handleToggleDone(id)
                        } else if (e.key === 'Enter' && e.shiftKey) {
                          // Shift+Enter commits the row and leaves edit mode
                          // without opening a fresh sibling — the "I'm done adding"
                          // exit, so you don't type a task, get an empty row, and
                          // have to press Enter a second time to dismiss it.
                          // (Ctrl+Enter would read as a right-click on macOS.)
                          e.preventDefault()
                          commitEdit(id, e.currentTarget.value)
                        } else if (e.key === 'Enter') {
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

                {/* Zoom, at the row's right edge and revealed on hover. It sits
                    here rather than beside the bullet because the bullet now
                    folds, and because a control in the gutter lands on top of
                    the nesting guides. The right edge is a fixed column — the
                    outline is capped at --col-w — so the arrow is always in the
                    same place no matter how short the label is, while being the
                    quietest thing in the row until you look for it. */}
                <button
                  className="zoom trailing"
                  onClick={() => setScope(id)}
                  aria-label={`Zoom into ${node.text}`}
                  title="Zoom in"
                >
                  ›
                </button>
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
