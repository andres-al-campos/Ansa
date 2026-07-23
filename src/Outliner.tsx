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
  moveNode,
  outdent,
  removeNode,
  roots,
  setDone,
  setText,
  toggleCollapsed,
  type NodeId,
  type Tree,
} from '@shared/tree'

// Row geometry, kept together so the indent and the nesting guides can't drift
// apart. INDENT is the px added per depth level; GUIDE_X0 is where a depth-0
// bullet's centre sits, so a guide for ancestor depth d lands at GUIDE_X0 +
// d*INDENT — directly under that ancestor's bullet.
const ROW_PAD = 6
const INDENT = 28
const GUIDE_X0 = 37

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

  /** Record a new tree as an undoable checkpoint. */
  function commit(next: Tree) {
    setHistory((h) => (next === h.present ? h : { past: [...h.past, h.present], present: next, future: [] }))
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
  const [hideDone, setHideDone] = useState(false)
  const [editing, setEditing] = useState<NodeId | null>(null)
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
  // Set when a press turns into a drag, so the bullet's click (which fires on
  // release) doesn't also zoom. Cleared by that click.
  const justDragged = useRef(false)

  useEffect(() => () => window.clearTimeout(wormTimer.current), [])

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
    setHistory((h) => ({ ...h, present: next }))
  }
  const adoptRef = useRef(adopt)
  adoptRef.current = adopt

  useEffect(() => {
    const es = new EventSource(EVENTS_URL)
    es.onmessage = (e) => {
      const { tree: next, origin } = JSON.parse(e.data) as { tree: Tree; origin: string | null }
      if (origin === ORIGIN) return // our own echo — already applied locally
      if (busyRef.current) {
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
    const { tree: next } = setDone(tree, id, willComplete)
    setTree(next)

    // Ripple when you complete something. Rather than shaking just the
    // completed node's own children — which looks patchy when a grandchild
    // lands and only some cousins move — send one clean wave down every row on
    // screen, indexed by its visible position. Un-checking never worms.
    if (willComplete) {
      const map = new Map<NodeId, number>()
      rows.forEach((r, i) => map.set(r.id, i))
      setWorm(map)
      window.clearTimeout(wormTimer.current)
      // Let the last row finish: its delay is maxIndex*100ms + 400ms of run.
      const maxIndex = Math.max(0, ...map.values())
      wormTimer.current = window.setTimeout(() => setWorm(new Map()), maxIndex * 100 + 500)
    }
  }

  function commitEdit(id: NodeId, text: string) {
    const trimmed = text.trim()
    // An emptied row is a deletion — matches how outliners behave.
    setTree(trimmed ? setText(tree, id, trimmed) : removeNode(tree, id))
    setEditing(null)
  }

  /**
   * Tab/Shift-Tab while editing. Commit the live text first so the reparent
   * doesn't discard it, then re-nest and keep the row in edit mode.
   */
  function reindent(id: NodeId, text: string, dir: 'in' | 'out') {
    const withText = setText(tree, id, text.trim())
    setTree(dir === 'in' ? indent(withText, id) : outdent(withText, id))
  }

  function addSibling(afterId: NodeId | null) {
    const parentId = afterId ? (byId(tree, afterId)?.parentId ?? null) : scope
    const { tree: next, id } = addChild(tree, parentId, '')
    setTree(next)
    setEditing(id)
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

  // The card that follows the pointer while dragging: just the grabbed item,
  // shown collapsed — never its children, even when dragging a parent.
  const dragNode = dragId ? byId(tree, dragId) : undefined

  return (
    <div className="app">
      <aside className="side">
        <p className="brand">
          An<span>sa</span>
        </p>
        <p className="tagline">the handle of a thing</p>

        <p className="sect">Where you are</p>
        <ol className="rail">
          <li className={scope ? '' : 'here'}>
            <button onClick={() => setScope(null)}>Everything</button>
          </li>
          {(scope ? lineage : roots(tree)).map((node, i) => (
            <li key={node.id} className={node.id === scope ? 'here' : ''}>
              <button
                style={{ paddingLeft: 8 + (scope ? i + 1 : 1) * 12 }}
                onClick={() => setScope(node.id)}
              >
                {node.text || 'Untitled'}
              </button>
            </li>
          ))}
        </ol>

        <p className="sect">View</p>
        <div className="filters">
          <label>
            <input type="checkbox" checked={leafOnly} onChange={(e) => setLeafOnly(e.target.checked)} />
            <span>
              Only what&rsquo;s doable
              <span className="fine">
                Hides anything with subtasks. Applies inside{' '}
                <span className="scopename">{scopeNode ? scopeNode.text : 'Everything'}</span> only.
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
        <nav className="crumbs" aria-label="Breadcrumb">
          <button className={scope ? '' : 'cur'} onClick={() => setScope(null)}>
            Everything
          </button>
          {lineage.map((node) => (
            <span key={node.id} style={{ display: 'contents' }}>
              <span className="sep">›</span>
              <button className={node.id === scope ? 'cur' : ''} onClick={() => setScope(node.id)}>
                {node.text || 'Untitled'}
              </button>
            </span>
          ))}
        </nav>

        <h1 className="scope-title">{scopeNode ? scopeNode.text : 'Everything'}</h1>
        <p className="scope-meta">
          {leafOnly
            ? `${openLeafCount} doable ${openLeafCount === 1 ? 'thing' : 'things'} in here`
            : scopeNode
              ? 'Everything under this'
              : 'All your projects'}
        </p>

        {scopeProgress.total > 0 && (
          <div className={'scope-progress' + (scopeProgress.pct === 100 ? ' complete' : '')}>
            <div className="pbar">
              <i style={{ width: `${scopeProgress.pct}%` }} />
            </div>
            <span className="pct">{scopeProgress.pct}%</span>
          </div>
        )}

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
            const wormIndex = worm.get(id)

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
                  (wormIndex !== undefined ? ' worm' : '') +
                  (dropHere === 'into' ? ' drop-into' : '') +
                  (dropHere === 'before' ? ' drop-before' : '') +
                  (dropHere === 'after' ? ' drop-after' : '')
                }
                style={
                  {
                    paddingLeft: flat ? ROW_PAD : ROW_PAD + depth * INDENT,
                    ...(wormIndex !== undefined ? { ['--worm-i' as string]: wormIndex } : {}),
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
                      className="label-input"
                      autoFocus
                      defaultValue={node.text}
                      onBlur={(e) => commitEdit(id, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          commitEdit(id, e.currentTarget.value)
                          addSibling(id)
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
              + add {scopeNode ? 'a subtask' : 'a project'}
            </button>
          )}
        </div>
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
