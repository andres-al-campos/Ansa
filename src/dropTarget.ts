/**
 * Where a dragged row would land, given where the pointer is.
 *
 * Split out of the component because it is a question, not a step: tree +
 * visible rows + pointer in, a drop target out, nothing mutated. That makes it
 * checkable on its own, which matters here — the depth arithmetic below is the
 * part of dragging that is easy to get subtly wrong and hard to see going wrong.
 */

import { depthAtGap, isAncestor, type NodeId, type Tree } from '@shared/tree'

/**
 * Where a dragged node would land relative to the row under the pointer.
 * 'return' is the item's own vacated slot — drop there to put it back untouched.
 * 'into' nests as the hovered row's first child. 'before'/'after' insert in a
 * gap; there `depth` is the level the pointer picked (via its X), so the same
 * gap can mean "sibling of the row above", "child of it", or any shallower
 * ancestor level — the insertion line's indent shows which.
 */
export type DropMode = 'before' | 'after' | 'into' | 'return'

export interface DropTarget {
  id: NodeId
  mode: DropMode
  /** For 'before'/'after': the chosen indent level to insert at. */
  depth?: number
}

/** The rows as drawn, in visual order — only what the hit-test needs of them. */
export interface HitRow {
  id: NodeId
  depth: number
}

/** One candidate row: its id and the box it occupies on screen. */
export interface RowHit {
  id: NodeId
  top: number
  bottom: number
  left: number
  height: number
}

/**
 * Resolve the pointer position to a drop target: which row, and which of its
 * three bands (top quarter = before, middle = into, bottom quarter = after).
 * Hovering the lifted item's own slot returns 'return' — drop there to put it
 * back untouched. Descendants aren't rendered mid-drag, so cycles can't arise.
 *
 * The middle band of a row is 'into' (nest as its first child). The top and
 * bottom quarters are insertion *gaps*; there the pointer's X picks a depth,
 * because a gap can mean several things — a gap below a deep child could drop
 * at that child's level, or outdent to any shallower ancestor level, or (if
 * the row above can take children) nest one deeper. depthAtGap works out the
 * legal range for the gap and clamps X into it.
 *
 * `hits` are the on-screen row boxes, measured by the caller: keeping the DOM
 * read outside means this function is pure, and the geometry constants come in
 * as arguments so the guide layout has a single owner.
 */
export function dropTargetAt(
  clientX: number,
  clientY: number,
  dragging: NodeId,
  tree: Tree,
  visible: HitRow[],
  hits: RowHit[],
  guideX0: number,
  indent: number,
): DropTarget | null {
  for (const hit of hits) {
    const { id } = hit
    if (clientY < hit.top || clientY > hit.bottom) continue
    // The item's own slot: dropping here returns it to where it started.
    if (id === dragging) return { id, mode: 'return' }
    // Belt and braces — a descendant shouldn't be rendered, but never nest
    // into one if it somehow is.
    if (isAncestor(tree, dragging, id)) return null
    const rel = (clientY - hit.top) / hit.height
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
    // guides live (guideX0 + d*indent); clientX is viewport-absolute, so
    // rebase it onto the row.
    const depth = depthAtGap(
      clientX - hit.left,
      above ? above.depth : null,
      below ? below.depth : null,
      guideX0,
      indent,
    )
    // Anchor to the row above the gap when there is one, inserting after it;
    // at the very top there's no row above, so anchor before the first row.
    return above ? { id: above.id, mode: 'after', depth } : { id: below!.id, mode: 'before', depth }
  }
  return null
}

/** Measure the on-screen row boxes the hit-test works against. */
export function measureRows(): RowHit[] {
  return [...document.querySelectorAll<HTMLElement>('.row[data-id]')].map((el) => {
    const r = el.getBoundingClientRect()
    return { id: el.dataset.id!, top: r.top, bottom: r.bottom, left: r.left, height: r.height }
  })
}
