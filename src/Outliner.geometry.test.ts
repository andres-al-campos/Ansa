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

test('the wipe names a keyframe the stylesheet actually defines', () => {
  // The slide is an inline `transition`, so it needs nothing from the sheet —
  // but the wipe is an inline `animation` naming a keyframe by string. An
  // unresolvable keyframe name is not a CSS error: the animation silently does
  // nothing, `both` never applies, and the initial inline clip is left in place
  // — so the children would be clipped away and never revealed.
  const named = source.match(/style\.animation = `(\S+) /)
  if (!named) throw new Error('Could not find the wipe animation in Outliner.tsx')
  // The terminator has to be an explicit `{`, not `\b`. A hyphen is a word
  // boundary, so `wipe-in\b` happily matches inside `wipe-in-renamed` — the
  // exact rename this test exists to catch, passing.
  expect(css).toMatch(new RegExp(`@keyframes\\s+${named[1]}\\s*\\{`))
})

test('the wipe and the slide share one clock', () => {
  // Both run for FOLD_RUN: the rows below slide for it, and the reveal edge
  // crosses the whole arriving group in it, with each row's delay and duration
  // scaled as a fraction of that total. Give the wipe its own constant and the
  // two drift — the edge finishing early leaves content sitting still while the
  // list is moving, finishing late leaves a gap open below a settled list.
  const transition = source.match(/transition = `transform \$\{(\w+)\}ms/)
  if (!transition) throw new Error('Could not find the slide transition in Outliner.tsx')

  // Both ends of the wipe's scaling, and the timer that strips it afterwards.
  const delay = source.match(/\(y \/ span\) \* (\w+)/)
  const run = source.match(/\(h \/ span\) \* (\w+)/)
  const clear = source.match(/setTimeout\(settle, (\w+)\)/)
  if (!delay || !run || !clear) throw new Error('Could not find the wipe timings in Outliner.tsx')

  expect(new Set([transition[1], delay[1], run[1], clear[1]]).size).toBe(1)
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
