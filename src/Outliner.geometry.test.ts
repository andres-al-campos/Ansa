/**
 * The row geometry constants in Outliner.tsx describe boxes that CSS actually
 * draws, and nothing at runtime checks the two agree. When they drift the app
 * still renders — the nesting guides just stop landing under the bullets they
 * belong to, by a pixel or two, which is easy to ship and hard to notice.
 *
 * That happened twice already: once when the twisty was removed and its 11px
 * slot went with it, and again when the bullet grew 16px → 18px and the guides
 * stayed where they were.
 *
 * jsdom does no layout, so this can't be caught by rendering. Read the
 * stylesheet as text instead and assert the numbers the TSX assumes are the
 * numbers the CSS sets.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import { GEOMETRY } from './Outliner'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, 'index.css'), 'utf8')
const source = readFileSync(join(here, 'Outliner.tsx'), 'utf8')
// The fold animation lives in its own module; the mask/slide timings are read
// from there rather than from the component that calls it.
const fold = readFileSync(join(here, 'useFoldAnimation.ts'), 'utf8')

/**
 * The value of one declaration inside the first rule matching `selector`.
 *
 * The selector may be any member of a comma-separated group — `.zoom` and
 * `.fold` share one block — so it can be followed by more of the group before
 * the `{`, or preceded by the members that came before it.
 */
function declaration(selector: string, property: string): string {
  const rule = css.match(
    // The selector starts a line; `(?:,[^{]*)?` lets the rest of the group —
    // possibly spanning further lines — follow before the body opens.
    new RegExp(`^\\${selector}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'm'),
  )
  if (!rule) throw new Error(`No CSS rule for "${selector}" — did the selector get renamed?`)
  // Strip comments first: a declaration can follow a `*/` rather than a `;`,
  // and the boundary below would miss it. Stripping also stops prose inside a
  // comment from matching as if it were a declaration.
  const declarations = rule[1].replace(/\/\*[\s\S]*?\*\//g, ';')
  const decl = declarations.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`))
  if (!decl) throw new Error(`"${selector}" sets no ${property}`)
  return decl[1].trim()
}

const px = (selector: string, property: string) =>
  parseFloat(declaration(selector, property))

test('the bullet is drawn at the size GUIDE_X0 was measured against', () => {
  expect(px('.bullet', 'width')).toBe(GEOMETRY.BULLET)
  // A non-round bullet would put its centre off a whole pixel and blur every
  // guide, so the box has to stay square as well as the right size.
  expect(px('.bullet', 'height')).toBe(GEOMETRY.BULLET)
})

test('the row gap is the one the guide offset assumes', () => {
  expect(px('.row', 'gap')).toBe(GEOMETRY.ROW_GAP)
})

test('no gutter rule survives to sit left of the bullet again', () => {
  // GUIDE_X0 used to carry a 15px gutter column plus a row gap, for the fold
  // triangle that lived left of the bullet. The triangle moved onto the bullet
  // and both terms went. GUIDE_X0 is a number, though, and it would go on
  // looking valid if a control were put back into that column without adding its
  // width back in — every nesting guide would then run one column left of the
  // bullets it belongs to, which renders fine and reads as a drawing bug.
  //
  // The stylesheet is where such a column would have to be declared, so pin its
  // absence there.
  expect(css).not.toMatch(/^\.fold\s*[,{]/m)
})

test('a mask item occupies the same box as the row it stands in for', () => {
  // The mask holds clones of the group's rows, one per `.fold-mask-item`. The
  // clone dropped the `.row` class — see useFoldAnimation.ts — so it
  // dropped `.row`'s box and has to restate it. Two copies of the same numbers
  // drift silently: the clone would sit a few pixels off the row it stands in
  // for, and the mask's edge would meet the sliding siblings out of true.
  for (const property of ['gap', 'padding', 'border-radius', 'align-items']) {
    expect(declaration('.fold-mask-item', property)).toBe(declaration('.row', property))
  }
})

test('the mask is fixed and clipped, so it stands over the list without joining it', () => {
  // The whole mechanism rests on the mask being out of flow (it displaces
  // nothing while the live list opens or closes beneath it) and clipping its
  // overflow (the edge that reveals or hides the clones is the box's own
  // bottom). Lose `overflow: hidden` and the clones spill past the animating
  // height — every child shows at once and the fold does nothing.
  expect(declaration('.fold-mask', 'position')).toBe('fixed')
  expect(declaration('.fold-mask', 'overflow')).toBe('hidden')
})

test('the mask and the slide share one clock', () => {
  // The mask's height and the siblings' transform are the two halves of one
  // motion. They only stay welded — no sliding row ever crossing a child still
  // drawn — if they run the same duration with the same easing and no offset
  // between them. All three of these read the same FOLD_RUN, `linear`, and no
  // delay; the cleanup timer waits exactly that long.
  const maskRun = fold.match(/height \$\{(\w+)\}ms (\w+)`/)
  const slideRun = fold.match(/transform \$\{(\w+)\}ms (\w+)`/)
  const clear = fold.match(/setTimeout\(settle, (\w+)\)/)
  if (!maskRun || !slideRun || !clear) {
    throw new Error('Could not find the fold timings in useFoldAnimation.ts')
  }
  // Same duration and same easing for the mask and the slide.
  expect(maskRun[1]).toBe(slideRun[1])
  expect(maskRun[2]).toBe(slideRun[2])
  expect(maskRun[2]).toBe('linear')
  // The cleanup waits for exactly that run.
  expect(clear[1]).toBe(maskRun[1])
  // Neither carries a delay — a `ms <n>ms` third value would offset one from the
  // other. The template literals end right after the easing word.
  expect(fold).toMatch(new RegExp(`height \\$\\{${maskRun[1]}\\}ms ${maskRun[2]}\``))
  expect(fold).toMatch(new RegExp(`transform \\$\\{${slideRun[1]}\\}ms ${slideRun[2]}\``))
})

test("the bullet's marker classes are not claimed by anything else", () => {
  // The fold spacer's marker started life as `empty`, which the sheet already
  // used for the empty-list placeholder — `padding: 18px 6px`. That padding won
  // against the button's own height and grew every *leaf* row to 38px against a
  // parent row's 32px, so the list's rhythm broke on exactly the rows with no
  // children. jsdom does no layout and every test still passed.
  //
  // The spacer is gone, but the bullet now carries its own markers — `folds`
  // among them — and a bare rule on any of those names would reach the bullet
  // regardless of what it was written for. Find them the way the DOM does, then
  // assert nothing claims them unqualified.
  const markers = [...source.matchAll(/\?\s*' (\w+)'\s*:\s*''/g)].map((m) => m[1])
  expect(markers, 'expected to find the bullet marker classes in Outliner.tsx').toContain('folds')

  for (const marker of markers) {
    // A rule on the bare class — `.folds {` — applies to the bullet regardless
    // of intent. Qualified rules (`.bullet.folds`) are deliberate and fine.
    const bare = new RegExp(`(?:^|[,}])\\s*\\.${marker}\\s*(?:,|\\{)`, 'm')
    expect(css, `".${marker}" should only be styled qualified`).not.toMatch(bare)
  }
})

test('the guide is centred on the bullet, not hung off its left edge', () => {
  // A 1px line placed at `left: GUIDE_X0` spans X→X+1 and so centres half a
  // pixel right of the bullet. The offset only cancels if GUIDE_W is the width
  // CSS actually draws, which is what this pins.
  expect(px('.guide', 'width')).toBe(GEOMETRY.GUIDE_W)
})

test('the guide is an odd width, so it centres on a half-pixel like the bullet', () => {
  expect(GEOMETRY.GUIDE_W % 2).toBe(1)
})

test("the row's horizontal padding is ROW_PAD", () => {
  // `padding: 5px 6px` — vertical first, then the horizontal value we indent by.
  const [, horizontal] = declaration('.row', 'padding').split(/\s+/)
  expect(parseFloat(horizontal)).toBe(GEOMETRY.ROW_PAD)
})

test('a depth-0 guide lands on the centre of a depth-0 bullet', () => {
  // The whole point of the constant, stated as the property it has to satisfy
  // rather than as the number it currently happens to be.
  const bulletCentre = GEOMETRY.ROW_PAD + GEOMETRY.BULLET / 2
  expect(GEOMETRY.GUIDE_X0).toBe(bulletCentre)
})

/**
 * The shell's widths are coupled by subtraction, not by repetition.
 *
 * `.main` carries a right padding that shifts the outline back onto the
 * window's centre — the grid puts it half a sidebar to the right of that — and
 * the size of the shift is derived from the sidebar, the column cap, and the
 * pane's padding. Written as literals, changing the sidebar in the grid would
 * leave the offset correcting for the old width, and the outline would sit off
 * centre by half the difference. Nothing renders wrong, so nothing catches it.
 *
 * These check the derivation is still a derivation.
 */

test('the sidebar track is auto, sized by the sidebar rather than a repeated width', () => {
  // The sidebar no longer sets the grid track directly. The first track is
  // `auto`, sized by the sidebar's margin-box, and the sidebar collapses by
  // animating its own margin — so the track has to stay `auto` for that
  // margin-box to size it. A literal `var(--side-w)` track here would pin the
  // column open and the collapse would slide the sidebar out from under a gap
  // that never closes.
  expect(declaration('.app', 'grid-template-columns')).toBe('auto 1fr')
})

test('the sidebar collapses by exactly its own width, so the track closes to zero', () => {
  // The collapse pulls the sidebar left by one full width; its margin-box then
  // measures zero and the auto track closes. Both terms have to be the same
  // --side-w: a literal, or a different variable, and the sidebar would leave a
  // sliver of open track or overshoot it.
  expect(declaration('.side', 'width')).toBe('var(--side-w)')
  const collapsed = declaration('.app.side-hidden > .side', 'margin-left').replace(/\s+/g, '')
  expect(collapsed).toBe('calc(-1*var(--side-w))')
})

test('the centred column is capped by the same variable the offset subtracts', () => {
  expect(declaration('.crumbs', 'max-width')).toBe('var(--col-w)')
})

test('the centring offset is derived from all three widths', () => {
  // Collapsed to one line: the declaration spans several in the source, and
  // what matters is which variables appear in it, not how it is wrapped.
  const pad = declaration('.main', 'padding-right').replace(/\s+/g, ' ')
  for (const v of ['--side-w', '--col-w', '--main-pad']) {
    expect(pad, `the offset should be derived from ${v}`).toContain(`var(${v})`)
  }
  // Clamped, or a window narrower than the sidebar plus the column slides the
  // outline underneath the sidebar instead of stopping short of it.
  expect(pad).toContain('clamp(')
})

test('the shell widths are declared once', () => {
  for (const v of ['--side-w', '--col-w', '--main-pad']) {
    const declared = css.match(new RegExp(`^\\s*${v}\\s*:`, 'gm')) ?? []
    expect(declared.length, `${v} should be defined exactly once`).toBe(1)
  }
})
