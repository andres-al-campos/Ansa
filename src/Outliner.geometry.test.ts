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

test('the gutter slot and row gap match what the guide offset assumes', () => {
  // The gutter button *is* the column — it holds the space open left of the
  // bullet, so its width is a term in GUIDE_X0. Sizing it to its glyph instead
  // of fixing it here would drag every nesting guide sideways. `.zoom` and
  // `.fold` share the rule; either name landing on a different width breaks it.
  // The button is deliberately bigger than its column — 15px was too small a
  // pointer target next to a bullet that does something else — so what has to
  // equal GUTTER is the space it *occupies*: width plus both margins.
  //
  // Read the two axes separately. `0 -4px` and `-4px` differ only in the
  // vertical value, and reading one number for both made a missing vertical
  // pull — which spreads every row apart — look like a passing test.
  const margin = declaration('.fold', 'margin').split(/\s+/).map(parseFloat)
  const [insetY, insetX] = margin.length === 1 ? [margin[0], margin[0]] : margin
  expect(px('.fold', 'width') + 2 * insetX).toBe(GEOMETRY.GUTTER)
  expect(px('.row', 'gap')).toBe(GEOMETRY.ROW_GAP)

  // Square, so `border-radius: 50%` on the disc is a circle rather than an
  // oval — it masks a guide, and an oval reads as a smear across the line.
  expect(px('.fold', 'height')).toBe(px('.fold', 'width'))
  expect(px('.fold::before', 'width')).toBe(px('.fold::before', 'height'))

  // The same pull vertically, and for the same kind of reason: an unmargined
  // 23px button is the tallest thing in the row and spreads the whole list out
  // by 4px a row. The bullet is what sets row height, so the button has to
  // occupy no more than it does.
  expect(px('.fold', 'height') + 2 * insetY).toBeLessThanOrEqual(GEOMETRY.BULLET)
})

test('a mask item occupies the same box as the row it stands in for', () => {
  // The mask holds clones of the group's rows, one per `.fold-mask-item`. The
  // clone dropped the `.row` class — see the effect in Outliner.tsx — so it
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
  const maskRun = source.match(/height \$\{(\w+)\}ms (\w+)`/)
  const slideRun = source.match(/transform \$\{(\w+)\}ms (\w+)`/)
  const clear = source.match(/setTimeout\(settle, (\w+)\)/)
  if (!maskRun || !slideRun || !clear) {
    throw new Error('Could not find the fold timings in Outliner.tsx')
  }
  // Same duration and same easing for the mask and the slide.
  expect(maskRun[1]).toBe(slideRun[1])
  expect(maskRun[2]).toBe(slideRun[2])
  expect(maskRun[2]).toBe('linear')
  // The cleanup waits for exactly that run.
  expect(clear[1]).toBe(maskRun[1])
  // Neither carries a delay — a `ms <n>ms` third value would offset one from the
  // other. The template literals end right after the easing word.
  expect(source).toMatch(new RegExp(`height \\$\\{${maskRun[1]}\\}ms ${maskRun[2]}\``))
  expect(source).toMatch(new RegExp(`transform \\$\\{${slideRun[1]}\\}ms ${slideRun[2]}\``))
})

test("the leaf fold's marker class is not styled by anything else", () => {
  // The marker started life as `empty`, which the sheet already used for the
  // empty-list placeholder — `padding: 18px 6px`. That padding won against the
  // button's own height and grew every *leaf* row to 38px against a parent
  // row's 32px, so the list's rhythm broke on exactly the rows with no
  // children. jsdom does no layout and every test still passed.
  //
  // Find the marker the way the DOM does, then assert no bare rule claims it.
  const marker = source.match(/\(parent \? '' : ' (\w+)'\)/)
  if (!marker) throw new Error('Could not find the leaf fold marker class in Outliner.tsx')

  // A rule on the bare class — `.leaf {` — applies to the button regardless of
  // what it was meant for. Qualified rules (`.fold.leaf`, `.bullet.leaf`) are
  // deliberate and fine.
  const bare = new RegExp(`(?:^|[,}])\\s*\\.${marker[1]}\\s*(?:,|\\{)`, 'm')
  expect(css).not.toMatch(bare)
})

test('the guide is centred on the bullet, not hung off its left edge', () => {
  // A 1px line placed at `left: GUIDE_X0` spans X→X+1 and so centres half a
  // pixel right of the bullet. The offset only cancels if GUIDE_W is the width
  // CSS actually draws, which is what this pins.
  expect(px('.guide', 'width')).toBe(GEOMETRY.GUIDE_W)
})

test('the zoom slot is odd, so it shares a centre with the 1px guide', () => {
  // An even slot would centre the button on a whole pixel while the odd guide
  // centres on a half — a half-pixel stagger between two things drawn as one
  // column, visible on a 2x display.
  expect(GEOMETRY.GUTTER % 2).toBe(1)
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
  const bulletCentre =
    GEOMETRY.ROW_PAD + GEOMETRY.GUTTER + GEOMETRY.ROW_GAP + GEOMETRY.BULLET / 2
  expect(GEOMETRY.GUIDE_X0).toBe(bulletCentre)
})
