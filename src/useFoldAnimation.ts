/**
 * Slide the rows below a fold to their new place instead of letting them jump.
 *
 * FLIP: measure where every row sits *before* the change (First), let React
 * relayout (Last), then transform each moved row back to where it looked like
 * it was (Invert) and release that transform with a transition (Play). The
 * rows below travel their true distance in one continuous move.
 *
 * Transform, not height. Animating height reflows the document every frame,
 * and a reflow per frame across a long list is what makes the list step down
 * a row at a time rather than glide. A transform is composited: no layout, so
 * the motion is smooth however many rows are below the fold.
 *
 * Only a fold animates. A scope change, a filter toggle, a delete and a drag
 * all move rows too, and each already has its own treatment — animating them
 * here as well would replay the whole list on every navigation. The test is
 * whether some row's collapsed flag just flipped while the row stayed on
 * screen: that is a fold, and nothing else is.
 *
 * The run is kept as one sequence rather than split into build/invert/play
 * steps: each stage depends on the previous one having run, so naming them
 * would promote that ordering into parameters without removing it.
 */

import { useLayoutEffect, useRef } from 'react'
import { byId, type NodeId, type Tree } from '@shared/tree'

// How long a fold takes, either direction: the mask over the children opens or
// shuts and the rows below travel to meet it, both on this one clock. Short
// enough not to sit in the way of a second click — folding is something you do
// repeatedly while scanning a list, so it has to be over before you want the
// next one.
export const FOLD_RUN = 150

// A sentinel row id for the "+ add a subtask" button, so the fold slide can
// carry it along with the real rows. No node ever has this id.
const ADD_KEY = '__add'

/** A row's box, as measured while it was still on screen. */
interface RowBox {
  left: number
  width: number
}

/** The visible rows, in draw order. Only the id is needed to spot the fold. */
interface FoldRow {
  id: NodeId
}

export function useFoldAnimation(tree: Tree, rows: FoldRow[]): void {
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
  const prevRects = useRef(new Map<NodeId, RowBox>())

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
    const rects = new Map<NodeId, RowBox>()
    for (const el of document.querySelectorAll<HTMLElement>('.row[data-id]')) {
      const id = el.dataset.id!
      const box = el.getBoundingClientRect()
      last.set(id, box.top)
      heights.set(id, box.height)
      rects.set(id, { left: box.left, width: box.width })
      els.set(id, el)
    }
    // The "+ add a subtask" button sits at the foot of the list, below every
    // row, so a fold above it moves it too. It isn't a `.row` and carries no id,
    // so give it a sentinel key and let it ride the same invert-and-slide as the
    // rows — otherwise it alone jumps to its new place while they glide.
    const adder = document.querySelector<HTMLElement>('.rows > .add')
    if (adder) {
      last.set(ADD_KEY, adder.getBoundingClientRect().top)
      els.set(ADD_KEY, adder)
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

    // One clock, not two.
    //
    // A collapse is an accordion: a band of children of height H opens or shuts,
    // and everything below it travels exactly H to make room or take it back.
    // The one rule that keeps it readable is that the band's moving edge and the
    // rows below stay welded together — the moment they drift, a sibling is
    // drawn in pixels a child still occupies, and you get two lines of text in
    // one place.
    //
    // The honest way to weld them is a real wrapper: put the children in a box
    // with `overflow: hidden`, animate its height, and the rows below follow for
    // free because the box takes real space. The row list is deliberately flat
    // (the drag hit-test and guides are built on it), so instead we fake exactly
    // that box: one fixed, clipped `mask` element holding clones of the group,
    // its height animated between the band's full height and nothing. The rows
    // below are slid by transform over the
    // *same* duration and easing, so the mask's near edge and the sibling tops
    // move as one. Because both are `H · progress` under `linear`, they cannot
    // come apart at any frame, however the browser schedules them.
    //
    // `mask` is the box; `masked` are the real rows it stands in for, which stay
    // clipped away underneath it until it's gone (open) or are already unmounted
    // (close). `moved` are the siblings that slide.
    let mask: HTMLElement | null = null
    const masked: HTMLElement[] = []
    const moved: HTMLElement[] = []

    // The group the mask covers, in visual order, each with the box it occupies.
    // Opening, it's the arriving rows at their new places; closing, it's the
    // departing rows at the places they just left (only their clones remain).
    const group: Array<{ el: HTMLElement; y: number; h: number }> = opening
      ? [...last.keys()]
          .filter((id) => !first.has(id))
          .map((id) => ({ el: els.get(id)!, y: last.get(id)!, h: heights.get(id)! }))
          .sort((a, b) => a.y - b.y)
      : departing
          .map((id) => {
            const clone = clones.get(id)
            const y = first.get(id)
            const h = goneHeights.get(id)
            const box = goneRects.get(id)
            if (!clone || y === undefined || h === undefined || !box) return null
            return { clone, y, h, left: box.left, width: box.width }
          })
          .filter((g): g is NonNullable<typeof g> => g !== null)
          .sort((a, b) => a.y - b.y)
          .map((g) => ({ el: g.clone, y: g.y, h: g.h }))

    const board = document.querySelector('.rows') as HTMLElement | null
    const groupTop = group.length ? Math.min(...group.map((g) => g.y)) : 0
    const groupH = group.length ? Math.max(...group.map((g) => g.y + g.h)) - groupTop : 0

    // Build the mask: a clipped box over the group's band, filled with a stack
    // of the group's rows at their offsets from the band's top. On open the
    // clones are of the live rows (identical content, so the swap is seamless);
    // on close they are last frame's clones, the only copy left.
    if (board && group.length) {
      mask = document.createElement('div')
      mask.className = 'fold-mask'
      mask.setAttribute('aria-hidden', 'true')
      mask.style.top = `${groupTop}px`
      // Left/width come from a group row so the clones line up with the list.
      const sample = opening ? rects.get(group[0].el.dataset.id!) : undefined
      const box = sample ?? (goneRects.get(departing[0]) as RowBox | undefined)
      mask.style.left = `${box?.left ?? 0}px`
      mask.style.width = `${box?.width ?? 0}px`
      // Starts at the band's full height when closing, at nothing when opening.
      mask.style.height = opening ? '0px' : `${groupH}px`
      for (const g of group) {
        // Clone the source row (a live arriving row, or an existing ghost clone)
        // and stack it inside the mask at its place within the band. It must not
        // answer to `.row` or carry a `data-id`: the hit-test and every walk of
        // the list select on those, and a stand-in caught there is a row that
        // isn't in the tree being counted.
        const item = g.el.cloneNode(true) as HTMLElement
        // Keep the source row's own classes (`done` draws the strike, and any
        // future state class rides along the same way) but drop `.row` and add
        // the mask class: the clone must look like the row it stands in for
        // without answering to the selector the list walks.
        item.classList.remove('row')
        item.classList.add('fold-mask-item')
        item.removeAttribute('data-id')
        item.style.top = `${g.y - groupTop}px`
        item.style.height = `${g.h}px`
        mask.appendChild(item)
      }
      board.appendChild(mask)
    }

    // The real arriving rows hide beneath the mask until it finishes, or the
    // mask's clones would double the content the mask is already showing. Clipped
    // rather than hidden so they still hold their space in the list.
    if (opening) {
      for (const g of group) {
        const live = g.el
        live.style.clipPath = 'inset(0 0 100% 0)'
        masked.push(live)
      }
    }

    // Invert the siblings that move: put them back where they appeared to be,
    // with no transition, so this frame paints identically to the last one.
    for (const [id, y] of last) {
      const was = first.get(id)
      if (was === undefined) continue
      const dy = was - y
      // Only rows below the fold move, and a sub-pixel delta is not motion.
      if (Math.abs(dy) < 0.5 || y < pivot) continue
      const el = els.get(id)!
      el.style.transition = 'none'
      el.style.transform = `translateY(${dy}px)`
      moved.push(el)
    }

    // Play on the next frame. Setting a transform and clearing it in the same
    // frame is a no-op — the browser coalesces both into the final value and
    // nothing animates. rAF forces the intermediate state to be observed.
    //
    // The mask and the slide start together, run the same FOLD_RUN, and share
    // `linear` so their progress is the same number at every instant. That is
    // the whole point: one clock. The mask goes to its far height (full when
    // opening, nothing when closing); the siblings release to their true place.
    const play = requestAnimationFrame(() => {
      if (mask) {
        mask.style.transition = `height ${FOLD_RUN}ms linear`
        mask.style.height = opening ? `${groupH}px` : '0px'
      }
      for (const el of moved) {
        el.style.transition = `transform ${FOLD_RUN}ms linear`
        el.style.transform = ''
      }
    })

    // Hand everything back once the run is over. A left-behind `transition:
    // transform` would quietly animate the next move of a sibling — a drag,
    // which has to track the pointer exactly. A left-behind clip is worse: the
    // arriving rows start fully clipped, so one that keeps it is invisible for
    // good rather than merely un-animated. The mask is a copy of rows, not rows,
    // so it goes rather than gets reset.
    const settle = () => {
      for (const el of moved) {
        el.style.transition = ''
        el.style.transform = ''
      }
      for (const el of masked) {
        el.style.clipPath = ''
      }
      mask?.remove()
    }

    // One timer covers both directions: each is done at FOLD_RUN.
    const clear = window.setTimeout(settle, FOLD_RUN)

    return () => {
      cancelAnimationFrame(play)
      window.clearTimeout(clear)
      // Unmounting mid-animation, or a second fold landing on top of this one:
      // strip the inline state so the incoming animation measures a settled row
      // rather than one frozen halfway through the last move — and so nothing is
      // left clipped out of existence or floating over the list.
      settle()
    }
  }, [rows, tree])
}
