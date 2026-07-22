import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addChild,
  byId,
  childrenOf,
  indent,
  isAncestor,
  isLeaf,
  leavesUnder,
  lineageOf,
  outdent,
  progressOf,
  removeNode,
  roots,
  setDone,
  setText,
  toggleCollapsed,
  type NodeId,
  type Tree,
} from './tree'

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
function visibleRows(tree: Tree, scope: NodeId | null, leafOnly: boolean, hideDone: boolean): VisibleRow[] {
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
      if (!child.collapsed) walk(child.id, depth + 1)
    }
  }
  walk(scope, 0)
  return out
}

export default function Outliner({ initial }: { initial: Tree }) {
  const [tree, setTree] = useState<Tree>(initial)
  const [scope, setScope] = useState<NodeId | null>(null)
  const [leafOnly, setLeafOnly] = useState(false)
  const [hideDone, setHideDone] = useState(false)
  const [editing, setEditing] = useState<NodeId | null>(null)
  /** ids currently running the worm, with their ripple index */
  const [worm, setWorm] = useState<Map<NodeId, number>>(new Map())
  const wormTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(wormTimer.current), [])

  const scopeNode = scope ? byId(tree, scope) : undefined
  // A scope whose node was deleted would strand the view.
  useEffect(() => {
    if (scope && !byId(tree, scope)) setScope(null)
  }, [tree, scope])

  const rows = useMemo(
    () => visibleRows(tree, scope, leafOnly, hideDone),
    [tree, scope, leafOnly, hideDone],
  )

  const openLeafCount = useMemo(() => {
    const leaves = scope ? leavesUnder(tree, scope) : roots(tree).flatMap((r) => leavesUnder(tree, r.id))
    return leaves.filter((l) => !l.done).length
  }, [tree, scope])

  function handleToggleDone(id: NodeId) {
    const node = byId(tree, id)
    if (!node) return
    const { tree: next, completed } = setDone(tree, id, !node.done)
    setTree(next)

    // Ripple the children of whatever just completed. The wave radiates out
    // from the item you actually ticked (its --worm-i is 0), so completing the
    // last child ripples upward, and completing a middle one ripples both ways.
    if (completed.length > 0) {
      const map = new Map<NodeId, number>()
      for (const parentId of completed) {
        const kids = childrenOf(next, parentId)
        // The ticked node lives in exactly one of these child branches.
        const origin = kids.findIndex((k) => k.id === id || isAncestor(next, k.id, id))
        const from = origin < 0 ? kids.length - 1 : origin
        kids.forEach((k, i) => map.set(k.id, Math.abs(i - from)))
      }
      setWorm(map)
      window.clearTimeout(wormTimer.current)
      // Let the furthest row finish: its delay is maxDist*100ms + 400ms of run.
      const maxDist = Math.max(0, ...map.values())
      wormTimer.current = window.setTimeout(() => setWorm(new Map()), maxDist * 100 + 500)
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

  const lineage = scope ? lineageOf(tree, scope) : []

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
            const parent = !isLeaf(tree, id)
            const prog = parent ? progressOf(tree, id) : null
            const wormIndex = worm.get(id)

            // Ancestry between the current scope and this leaf, for the chip.
            const chip = flat
              ? lineageOf(tree, id)
                  .slice(scope ? lineageOf(tree, scope).length : 0, -1)
                  .map((a) => a.text)
                  .join(' › ')
              : ''

            return (
              <div
                key={id}
                className={
                  'row' +
                  (node.done ? ' done' : '') +
                  (prog?.pct === 100 ? ' complete' : '') +
                  (wormIndex !== undefined ? ' worm' : '')
                }
                style={
                  {
                    paddingLeft: flat ? 6 : 6 + depth * 22,
                    ...(wormIndex !== undefined ? { ['--worm-i' as string]: wormIndex } : {}),
                  } as React.CSSProperties
                }
              >
                <button
                  className={'twisty' + (parent && !flat ? (node.collapsed ? '' : ' open') : ' hidden')}
                  onClick={() => setTree(toggleCollapsed(tree, id))}
                  aria-label={node.collapsed ? 'Expand' : 'Collapse'}
                  tabIndex={parent && !flat ? 0 : -1}
                >
                  ▶
                </button>

                <button
                  className={'bullet ' + (parent ? 'parent' : 'leaf')}
                  onClick={() => setScope(id)}
                  aria-label={`Zoom into ${node.text}`}
                  title="Zoom in"
                />

                <button
                  className="check"
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
                      {node.text || <span style={{ color: 'var(--ink-ghost)' }}>Untitled</span>}
                      {chip && <span className="chip">{chip}</span>}
                    </div>
                  )}

                  {prog && !flat && prog.pct > 0 && (
                    <div className="progress">
                      <div className="pbar">
                        <i style={{ width: `${prog.pct}%` }} />
                      </div>
                      <span className="pct">{prog.pct}%</span>
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
    </div>
  )
}
