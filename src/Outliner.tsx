import { useEffect, useMemo, useRef, useState } from 'react'
import { exportTree, parseTree, saveTree } from './storage'
import { EVENTS_URL, ORIGIN, putTree } from './api'
import {
  addChild,
  byId,
  childrenOf,
  indent,
  isAncestor,
  isLeaf,
  leavesUnder,
  lineageOf,
  markOpened,
  moveNode,
  outdent,
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
const GUIDE_X0 = 32

// Completion worm: each row wiggles for WORM_RUN, offset from the previous by
// WORM_STAGGER. On long waves the stagger tightens so the whole sweep clears
// within WORM_CAP instead of crawling — same little wave, just faster.
const WORM_RUN = 400
const WORM_STAGGER = 100
const WORM_CAP = 1000

/**
 * Where a dragged node would land relative to the row under the pointer.
 * 'return' is the item's own vacated slot — drop there to put it back untouched.
 */
type DropMode = 'before' | 'after' | 'into' | 'return'
interface DropTarget {
  id: NodeId
  mode: DropMode
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
   *  instead of racing on a stale closure value. */
  function commit(next: Tree | ((prev: Tree) => Tree)) {
    setHistory((h) => {
      const value = typeof next === 'function' ? (next as (prev: Tree) => Tree)(h.present) : next
      return value === h.present ? h : { past: [...h.past, h.present], present: value, future: [] }
    })
  }
  /** Replace the tree *without* a checkpoint — for undo/redo themselves. */
  function setPresent(next: Tree) {
    setHistory((h) => ({ ...h, present: next }))
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
    setPresent(markOpened(tree, root))
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
  const [ghostAt, setGhostAt] = useState<{ x: number; y: number } | null>(null)
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

  // The first paint comes from the localStorage cache, which may be stale — the
  // server could hold newer nodes this tab has never seen. Until we've adopted
  // the server's authoritative tree at least once (the SSE stream sends it on
  // connect), a local edit must not be pushed back: a whole-tree PUT off the
  // stale cache would wipe those unseen server nodes. `synced` flips true on the
  // first adopt, opening the write path.
  const synced = useRef(false)

  // Persist on every change. The server (SQLite) is the source of truth;
  // localStorage is kept as an offline cache so a reload with the server down
  // still shows the last state instead of a blank screen. The very first render
  // carries the initial tree we were handed, so skip saving it back untouched.
  const firstSave = useRef(true)
  useEffect(() => {
    saveTree(tree)
    if (firstSave.current) {
      firstSave.current = false
      return
    }
    // Don't clobber the server with the unverified cache before first sync.
    if (!synced.current) return
    void putTree(tree)
  }, [tree])

  // Subscribe to server changes over SSE. The stream sends the current tree on
  // connect (so this also handles the initial load from the shared truth) and
  // then pushes the new tree after every write from anyone — a human in another
  // tab, or a Claude on the MCP. The browser writes over REST as before; this
  // is the one-way "something changed" channel back.
  //
  // Two things keep a local edit from being disturbed:
  //  - The broadcast carries the origin that caused it; we ignore the echo of
  //    our own writes (they're already in `present`).
  //  - While the user is mid-edit or dragging we don't apply an incoming tree;
  //    we stash it and adopt it the moment they're idle, so nothing is yanked
  //    out from under them and no external change is lost.
  const busyRef = useRef(false)
  busyRef.current = editing !== null || dragId !== null
  const pending = useRef<Tree | null>(null)
  const adopt = (next: Tree) => {
    firstSave.current = true // adopting isn't a change to push back
    synced.current = true // the server's tree is now in hand; writes are safe
    setHistory((h) => ({ ...h, present: next }))
  }
  const adoptRef = useRef(adopt)
  adoptRef.current = adopt

  useEffect(() => {
    const es = new EventSource(EVENTS_URL)
    es.onmessage = (e) => {
      const { tree: next, origin } = JSON.parse(e.data) as { tree: Tree; origin: string | null }
      if (origin === ORIGIN) return // our own echo — already applied locally
      // Adopt the server's tree even mid-edit until we've synced once: that
      // first message is the authoritative baseline, and it must land before
      // any write so a stale-cache edit can't be pushed over newer server data.
      // After that, hold incoming trees while the user is busy as usual.
      if (busyRef.current && synced.current) {
        pending.current = next // hold until the user is idle
        return
      }
      adoptRef.current(next)
    }
    return () => es.close()
  }, [])

  // When the user finishes an edit or drag, apply anything that arrived while
  // they were busy.
  useEffect(() => {
    if (!busyRef.current && pending.current) {
      const next = pending.current
      pending.current = null
      adoptRef.current(next)
    }
  }, [editing, dragId])

  // Cmd/Ctrl+Z undo, +Shift+Z (or Ctrl+Y) redo. Skipped while editing a label,
  // so the text field keeps its own native undo. Refs keep the listener stable.
  const undoRef = useRef(undo)
  undoRef.current = undo
  const redoRef = useRef(redo)
  redoRef.current = redo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const k = e.key.toLowerCase()
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
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
  function hitTest(clientY: number): DropTarget | null {
    const dragging = dragIdRef.current
    if (!dragging) return null
    const t = treeRef.current
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
      const mode: DropMode = rel < 0.25 ? 'before' : rel > 0.75 ? 'after' : 'into'
      return { id, mode }
    }
    return null
  }

  function finishDrag() {
    const dragging = dragIdRef.current
    const target = drop
    setDragId(null)
    setDrop(null)
    setGhostAt(null)
    // The suppress-the-zoom flag was set when the drag began; clear it just
    // after this release so it only guards the click that immediately follows,
    // never a later tap (the click may not even land on the dragged bullet).
    window.setTimeout(() => (justDragged.current = false), 0)

    if (!dragging || !target || dragging === target.id) return

    const t = treeRef.current
    const node = byId(t, target.id)
    if (!node) return

    if (target.mode === 'into') {
      // Nest as the first child; open the parent so the move is visible.
      let next = moveNode(t, dragging, target.id, 0)
      if (node.collapsed) next = toggleCollapsed(next, target.id)
      setTree(next)
    } else {
      const siblings = childrenOf(t, node.parentId).filter((n) => n.id !== dragging)
      const pos = siblings.findIndex((n) => n.id === target.id)
      const index = target.mode === 'before' ? pos : pos + 1
      setTree(moveNode(t, dragging, node.parentId, index))
    }
  }

  // While a drag is live, track the pointer globally and end on release.
  useEffect(() => {
    if (!dragId) return
    const onMove = (e: PointerEvent) => {
      e.preventDefault()
      setDrop(hitTest(e.clientY))
      setGhostAt({ x: e.clientX, y: e.clientY })
    }
    const onUp = () => finishDrag()
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    // finishDrag/hitTest read from refs, so this only needs to re-bind per drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragId, drop])

  // Bullet pointerdown: arm a long-press. A move beyond a few px before it
  // fires cancels it (that was a scroll or a click), otherwise the drag begins.
  function onBulletPointerDown(e: React.PointerEvent, id: NodeId) {
    if (leafOnly) return // structure isn't shown in the flattened view
    const startX = e.clientX
    const startY = e.clientY
    const timer = window.setTimeout(() => {
      const p = press.current
      press.current = null
      justDragged.current = true // suppress the zoom-click that ends this press
      setDragId(id)
      setDrop(null)
      if (p) setGhostAt({ x: p.x, y: p.y })
    }, 350)
    press.current = { id, x: startX, y: startY, timer }

    const cancelIfMoved = (ev: PointerEvent) => {
      if (!press.current) return
      if (Math.abs(ev.clientX - press.current.x) > 6 || Math.abs(ev.clientY - press.current.y) > 6) {
        window.clearTimeout(press.current.timer)
        press.current = null
      }
    }
    const cleanup = () => {
      if (press.current) {
        window.clearTimeout(press.current.timer)
        press.current = null
      }
      window.removeEventListener('pointermove', cancelIfMoved)
      window.removeEventListener('pointerup', cleanup)
    }
    window.addEventListener('pointermove', cancelIfMoved)
    window.addEventListener('pointerup', cleanup)
  }

  const scopeNode = scope ? byId(tree, scope) : undefined
  // A scope whose node was deleted would strand the view.
  useEffect(() => {
    if (scope && !byId(tree, scope)) setScope(null)
  }, [tree, scope])

  const rows = useMemo(
    () => visibleRows(tree, scope, leafOnly, hideDone, dragId),
    [tree, scope, leafOnly, hideDone, dragId],
  )

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
    setTree(next)

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

  function commitEdit(id: NodeId, text: string) {
    const trimmed = text.trim()
    // An emptied row is a deletion — matches how outliners behave.
    setTree((prev) => (trimmed ? setText(prev, id, trimmed) : removeNode(prev, id)))
    // Only clear editing if we're still on this row. A blur fired *because*
    // Enter already moved editing to a fresh sibling must not yank it back.
    setEditing((cur) => (cur === id ? null : cur))
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
    const { tree: next, id: newId } = addChild(renamed, parentId, '')
    setTree(next)
    setEditing(newId)
  }

  // Delete a row and land the cursor on the previous visible row, so clearing a
  // task out with the keyboard flows straight on rather than dead-ending. With
  // no previous row (it was the first), just leave edit mode.
  // `stepBack` moves edit focus to the previous row after deleting. Enter passes
  // it (one deliberate keypress, one step). Backspace does not: a held Backspace
  // would otherwise chain-delete row after row and could wipe a whole project,
  // so it deletes the empty row and drops out of edit mode, making you re-enter
  // to continue.
  function deleteRow(id: NodeId, stepBack: boolean) {
    const idx = rows.findIndex((r) => r.id === id)
    const prev = idx > 0 ? rows[idx - 1].id : null
    setTree(removeNode(tree, id))
    setEditing(stepBack ? prev : null)
  }

  // Renaming the scope title. Unlike a row, an emptied title is kept as-is —
  // clearing a whole project's name shouldn't delete the project.
  function commitTitle(id: NodeId, text: string) {
    const trimmed = text.trim()
    if (trimmed) setTree(setText(tree, id, trimmed))
    setEditing(null)
  }

  /**
   * Tab/Shift-Tab while editing. Commit the live text first so the reparent
   * doesn't discard it, then re-nest and keep the row in edit mode.
   */
  function reindent(id: NodeId, text: string, dir: 'in' | 'out') {
    setTree((prev) => {
      const withText = setText(prev, id, text.trim())
      return dir === 'in' ? indent(withText, id) : outdent(withText, id)
    })
  }

  function addSibling(afterId: NodeId | null) {
    const parentId = afterId ? (byId(tree, afterId)?.parentId ?? null) : scope
    const { tree: next, id } = addChild(tree, parentId, '')
    setTree(next)
    setEditing(id)
  }

  // Start a new project: a fresh root, scoped into and put straight into edit
  // so you name it in place.
  function newProject() {
    const { tree: next, id } = addChild(tree, null, '')
    setTree(next)
    setScope(id)
    setEditing(id)
  }

  function togglePin(id: NodeId) {
    const node = byId(tree, id)
    if (!node) return
    setTree(setPinned(tree, id, !node.pinned))
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
    setTree(removeNode(tree, id))
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
    setTree(moveNode(tree, dragging, null, after ? pos + 1 : pos))
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
      setTree(next)
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
              Show only leaf tasks
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
              Hide finished
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
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              if (scopeNode) e.currentTarget.textContent = scopeNode.text || 'Untitled'
              setEditing(null)
            }
          }}
          title={scopeNode ? 'Click to rename' : undefined}
        >
          {scopeNode ? scopeNode.text || 'Untitled' : 'Projects'}
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
                  } as React.CSSProperties
                }
              >
                {/* Nesting guides: one vertical line per level of ancestry, so
                    you can read what belongs under what without counting indent. */}
                {!flat &&
                  depth > 0 &&
                  Array.from({ length: depth }, (_, d) => (
                    // Each line sits under the bullet of the ancestor at depth d.
                    <span key={d} className="guide" style={{ left: GUIDE_X0 + d * INDENT }} aria-hidden />
                  ))}

                <button
                  className={'twisty' + (parent && !flat ? (node.collapsed ? '' : ' open') : ' hidden')}
                  onClick={() => setPresent(toggleCollapsed(tree, id))}
                  aria-label={node.collapsed ? 'Expand' : 'Collapse'}
                  tabIndex={parent && !flat ? 0 : -1}
                >
                  ▶
                </button>

                <button
                  className={'bullet ' + (bulletParent ? 'parent' : 'leaf')}
                  onPointerDown={flat ? undefined : (e) => onBulletPointerDown(e, id)}
                  onClick={() => {
                    // A press that became a drag must not also zoom.
                    if (justDragged.current) {
                      justDragged.current = false
                      return
                    }
                    setScope(id)
                  }}
                  aria-label={`Zoom into ${node.text}`}
                  title={flat ? 'Zoom in' : 'Zoom in — or hold to drag'}
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
                          // Enter on an empty row deletes it and steps back,
                          // rather than spawning yet another empty sibling.
                          if (empty) deleteRow(id, true)
                          else commitAndAddSibling(id, e.currentTarget.value)
                        } else if (e.key === 'Backspace' && empty) {
                          // Backspace on an empty row removes it but drops out of
                          // edit mode rather than stepping into the previous row,
                          // so a held key can't chain-delete the whole project.
                          e.preventDefault()
                          deleteRow(id, false)
                        } else if (e.key === 'Escape') {
                          setEditing(null)
                        } else if (e.key === 'Tab' && !leafOnly) {
                          // Reparenting is incoherent in the flattened leaf view.
                          e.preventDefault()
                          reindent(id, e.currentTarget.value, e.shiftKey ? 'out' : 'in')
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
          style={{ left: ghostAt.x + 12, top: ghostAt.y + 8 } as React.CSSProperties}
          aria-hidden
        >
          <span className={'bullet ' + (isLeaf(tree, dragNode.id) ? 'leaf' : 'parent')} />
          <span className="ghost-label">{dragNode.text || 'Untitled'}</span>
        </div>
      )}
    </div>
  )
}
