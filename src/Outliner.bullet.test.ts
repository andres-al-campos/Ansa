/**
 * The bullet's three states are drawn entirely with pseudo-elements, and two
 * separate bugs have now come from CSS *shorthands* quietly resetting a
 * longhand that something else depends on:
 *
 *  - `border: none` on the collapsed disc reset border-color to `currentcolor`
 *    — the near-white body ink. Because border-color is transitioned, unfolding
 *    animated the ring from white to its real colour: a white flash on every
 *    click, on a control you click constantly.
 *  - an earlier halo rule set only `background`, which does nothing to a ring
 *    drawn as a border, so expanded rows went unmarked as drop targets.
 *
 * Neither is catchable by rendering: jsdom computes no pseudo-element styles.
 * Read the stylesheet as text instead and pin the properties whose absence is
 * invisible until you watch a transition frame by frame.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.css'), 'utf8')

/**
 * The declarations of the first rule whose selector matches exactly, pseudos
 * included, with comments replaced by `;`.
 *
 * Stripping is not cosmetic. These rules carry long comments, and every caller
 * matches on `(?:^|;)` boundaries — a declaration written after a `*​/` is
 * invisible to that, so a rule can appear to set nothing at all. Assertions
 * phrased as `not.toMatch` then pass against the empty result and the guard
 * quietly stops guarding. Prose inside a comment can also read as a
 * declaration, which fails the other way.
 */
function body(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = css.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'))
  if (!rule) throw new Error(`No CSS rule for "${selector}" — did the selector get renamed?`)
  return rule[1].replace(/\/\*[\s\S]*?\*\//g, ';')
}

/** Every declaration of `property` in a rule, longhand only (not `border-color`
 *  when asking for `border`). `body` has already stripped comments. */
function declarations(selector: string, property: string): string[] {
  return [...body(selector).matchAll(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'g'))].map(
    (m) => m[1].trim(),
  )
}

test('the collapsed disc never resets its border colour to currentcolor', () => {
  const rule = body('.bullet.parent.collapsed::before')

  // `border: none` / `border: 0` is the trap: the shorthand takes border-color
  // back to currentcolor, and the transition then animates *from* white.
  expect(rule).not.toMatch(/(?:^|;)\s*border\s*:/)

  // Whatever it does to the width, the colour has to stay the bullet's own —
  // any bullet token will do, since what matters is that it is never white.
  expect(declarations('.bullet.parent.collapsed::before', 'border-color')).toEqual(['var(--mark)'])
})

test('the two surround forms are told apart by shape, not by colour', () => {
  // Ring and disc share one token on purpose: they differ by 2px vs 0px border
  // and 14px vs 18px diameter, which reads without any colour information and
  // survives a reader who cannot separate two close greys. Pin the shared token
  // so a later "let's tint the collapsed one" lands as a deliberate change.
  expect(declarations('.bullet.parent::before', 'border')).toEqual(['2px solid var(--mark)'])
  expect(declarations('.bullet.parent.collapsed::before', 'background')).toEqual(['var(--mark)'])

  // Both themes have to define the token, or one of them falls back to nothing.
  for (const token of ['--mark', '--mark-hover', '--mark-dot', '--ink-struck']) {
    // `--mark` is a prefix of the rest, so the count needs a boundary.
    expect(css.match(new RegExp(`${token}(?!-)\\s*:`, 'g'))).toHaveLength(2)
  }
})

test('the dot is brighter than its surround in every state', () => {
  // One rule for all three states rather than a special case for the disc: the
  // dot is the drag handle and the only constant part, so it is always the lit
  // thing and the surround is context around it. Filling the disc in then needs
  // no exception — the dot is already ahead of it.
  expect(declarations('.bullet::after', 'background')).toEqual(['var(--mark-dot)'])
  expect(css).not.toMatch(/^\.bullet\.parent\.collapsed::after/m)

  // Hover must not send the dot *backwards*. --mark-dot already sits above
  // --mark-hover, so the generic surround-hover value would darken it.
  expect(declarations('.bullet:hover::after', 'background')).toEqual(['var(--ink)'])
})

test('all three states light as a brass outline of the same weight', () => {
  // The drop highlight must not depend on how the row happens to be folded.
  // Expanded already draws a 2px ring; collapsed and leaf are made to match.
  expect(declarations('.row.drop-into .bullet::before', 'border-color')).toEqual(['var(--brass)'])

  // The collapsed rule adds a stroke to an existing box, so it sets longhands;
  // the leaf rule builds its box from nothing and uses the shorthand. Either
  // way the drawn result has to be the same 2px brass ring.
  for (const selector of [
    '.row.drop-into .bullet.parent.collapsed::before',
    '.row.drop-into .bullet.leaf::before',
  ]) {
    const rule = body(selector)
    expect(rule).toMatch(/border(?:-width)?\s*:\s*(?:2px|2px solid)/)
    expect(rule).toMatch(/border(?:-color)?\s*:\s*(?:2px solid )?var\(--brass\)/)
  }
})

test('no drop rule fills a bullet or touches its dot', () => {
  // Filling the disc lit a solid 18px of brass where the other two states lit a
  // 2px line, so the same row flared far brighter collapsed than expanded.
  expect(body('.row.drop-into .bullet.parent.collapsed::before')).not.toMatch(
    /(?:^|;)\s*background\s*:/,
  )

  // Brassing the dot turns a dot-inside-a-highlight into one solid blob, and
  // did it for leaves only — a third behaviour across three states.
  expect(css).not.toMatch(/^\.row\.drop-into \.bullet[^{]*::after/m)
})

test('zoom is revealed by hover but stays the quietest thing in the row', () => {
  // The point of moving zoom to the right edge was that it stops competing:
  // it used to be a triangle in the gutter that landed on a nesting guide and
  // needed a painted disc to break the line under it. At the edge it needs
  // none of that, but it does need to stay dimmer than the label it sits
  // beside, or it becomes the loudest thing on every hovered row.
  //
  // --ink-ghost is the dimmest ink token; the label is --ink. Assert the value,
  // not merely that it isn't --ink: a negative assertion also passes when the
  // property is missing and the button inherits body text.
  expect(declarations('.zoom', 'color')).toEqual(['var(--ink-ghost)'])
  expect(declarations('.zoom', 'opacity')).toEqual(['0'])
  expect(declarations('.row:hover .zoom', 'opacity')).toEqual(['1'])

  // Pointing at it lifts it one step, to --ink-mid — visible as a target
  // without reaching body-text weight.
  expect(declarations('.row:hover .zoom:hover', 'color')).toEqual(['var(--ink-mid)'])
})

test('zoom is reachable by keyboard, not only by hover', () => {
  // A control revealed only on `:hover` is invisible to anyone tabbing to it —
  // it takes focus while painted at opacity 0, so the focus ring lands on
  // nothing and the row looks unresponsive. Focus has to do what hover does,
  // and then some: there is no cursor to corroborate it, so it also fills.
  expect(declarations('.zoom:focus-visible', 'opacity')).toEqual(['1'])
  expect(declarations('.zoom:focus-visible', 'background')).toEqual(['var(--edge-lit)'])
})

test('zoom is pushed to the row edge by auto margin, not by a fixed width', () => {
  // The row is flex and the label takes the slack, so `margin-left: auto` is
  // what puts the arrow at the edge. A fixed width or a right offset instead
  // would put it a different distance in on every row, since labels differ —
  // and the whole reason it works as the quiet control is that it is in the
  // same place every time.
  const margin = declarations('.zoom', 'margin')
  expect(margin).toHaveLength(1)
  expect(margin[0].split(/\s+/).at(-1)).toBe('auto')
})

test('the collapsed drop rule outranks the expanded ring it overrides', () => {
  // `.bullet.collapsed::before` ties with `.bullet.parent::before` on
  // specificity, and the loser of a tie is whichever comes first. Naming all
  // three classes wins outright instead of depending on rule order.
  expect(css).toContain('.row.drop-into .bullet.parent.collapsed::before')
  expect(css).not.toMatch(/\.row\.drop-into \.bullet\.collapsed::before/)
})

/**
 * The hovered row's band was `var(--sunk)`, which is 1.027:1 against the dark
 * ground — a change too small to see, which is what put this test here. --sunk
 * still paints three other things, so the fix was a token of its own rather
 * than a brighter --sunk. Pin the separation: if the row hover goes back to
 * --sunk, it goes back to invisible.
 */
test('the hovered row has its own background token, not the shared --sunk', () => {
  expect(declarations('.row:hover', 'background')).toEqual(['var(--row-hover)'])
  // Defined in both themes — light in :root, dark in the media block. A token
  // declared once renders one theme's band on the other theme's ground.
  expect(css.match(/--row-hover:/g)).toHaveLength(2)
})

/**
 * Everything draggable says so once you take hold of it. The sheet used to
 * argue the opposite — hold-to-drag was treated as a power-user gesture nothing
 * advertised — so this test exists to stop that decision drifting back in.
 *
 * The bullet gets there without `:active`, though, and the difference matters.
 * A press on a parent bullet is usually a fold, and `.bullet:active` would flash
 * grabbing the instant that click began — promising a drag the click won't
 * perform. So the bullet's grabbing cursor rides `body.dragging`, which the
 * outliner sets only once a row is actually lifted; a leaf rests on grab, a
 * parent on pointer. The rail rows have no fold-click to collide with, so they
 * keep the plain `:active` scheme. If the bullet's grabbing cursor drifts back
 * onto `:active`, the fold-click flash comes back with it.
 */
test('the drag handles show a grab cursor', () => {
  // A leaf has no fold, so its resting cursor is the grab.
  expect(declarations('.bullet:not(.folds)', 'cursor')).toEqual(['grab'])
  // The bullet's grabbing cursor is armed by a live drag, not by a press — so it
  // sits on body.dragging, never on .bullet:active (which would fire on a fold).
  expect(declarations('body.dragging, body.dragging .bullet', 'cursor')).toEqual(['grabbing'])
  expect(css).not.toMatch(/\.bullet:active/)
  // The rail's draggable rows have no fold-click, so grabbing on the press is
  // safe there and still the scheme. Matched against the text rather than
  // through `body()` because this rule shares its block with `.rail.pins .pin`,
  // and that helper only reads a rule whose named selector runs straight to `{`.
  expect(css).toMatch(/\.rail\.projects \.proj:active[^{]*\{\s*cursor:\s*grabbing/)
})

/**
 * Editing happens inside the row, not in a panel on top of it: one highlighted
 * rectangle at a time, and no height change when you click in. Both used to be
 * wrong — a filled bordered box nested in the hover band, 8px taller than a
 * display row.
 */
test('the in-place editor adds no box and no height', () => {
  // A border and a background are what made it a second box; the brass survives
  // as an inset shadow, which paints in the same place and adds no height.
  expect(declarations('.label-input', 'border')).toEqual(['none'])
  expect(declarations('.label-input', 'background')).toEqual(['none'])
  expect(declarations('.label-input', 'box-shadow')).toEqual([
    'inset 0 0 0 1px var(--brass)',
  ])
  // An inline-block would sit on a text baseline and its line box would add
  // descender space under it, which is a height change by another route.
  expect(declarations('.label-input', 'display')).toEqual(['block'])
  // The margin hack that used to pull the taller box back into line is gone.
  expect(declarations('.label-input', 'margin-top')).toEqual([])
})

/**
 * The bullet and the checkbox are nudged down from the row's top to sit on the
 * first text line — the row is flex-start, so a wrapped row keeps them beside
 * line one rather than floating to the middle. Both offsets had been tuned by
 * eye and both sat ~2px low; nothing drew an edge to measure them against until
 * the editor's brass box did. They derive from the 21.75px line box, so pin the
 * derivation rather than the taste.
 */
test('the bullet and checkbox centre on the first text line', () => {
  const line = 22 // the row's line box, a whole number so gaps divide evenly
  const offset = (box: number) => `${(line - box) / 2}px`
  // (21.75 - 18) / 2 — the bullet's box is 18px.
  expect(declarations('.bullet', 'margin-top')).toEqual([offset(18)])
  // (22 - 15) / 2 — a half-pixel, kept rather than rounded: on a 15px square
  // that is visible.
  expect(declarations('.check', 'margin-top')).toEqual([offset(15)])
})

/**
 * The brass fills the row's height instead of hugging the text. It gets there
 * by taking the row's own padding and handing it straight back as a negative
 * margin, which is also what keeps the text from jumping when you click in.
 */
test('the editor fills the row without moving the row or the text', () => {
  const nums = (prop: string) =>
    declarations('.label-input', prop)[0].split(/\s+/).map(parseFloat)
  const pad = nums('padding')
  const margin = nums('margin')
  // Padding and margin must cancel on both axes, or the row changes height and
  // the text shifts sideways on entering edit mode. Pin that they cancel, not
  // what they are: the values are the row's own padding less a breathing gap,
  // and that gap is a matter of taste.
  expect(margin).toEqual(pad.map((v) => -v))
  // The box stops short of the row's edge rather than bleeding to it. Under the
  // row's 5px/6px padding, so the gold always sits inside the hover band.
  expect(pad[0]).toBeLessThan(5)
  expect(pad[1]).toBeLessThan(6)
  // The negative horizontal margin widens the box past its container by exactly
  // what it gave back on each side.
  expect(declarations('.label-input', 'width')).toEqual([
    `calc(100% + ${pad[1] * 2}px)`,
  ])
  // Sharing the row's shape means sharing its corner radius.
  expect(declarations('.label-input', 'border-radius')).toEqual(['6px'])
})

/**
 * The zoom button's hover pill is square around a square icon. Its padding has
 * to stay even for that, and small enough that the button doesn't become the
 * tallest thing in the row — at 5px it set the row's height and grew every row
 * by 4px.
 */
test('the zoom button is square and does not drive the row height', () => {
  const pad = declarations('.zoom', 'padding')
  expect(pad).toHaveLength(1)
  expect(new Set(pad[0].split(/\s+/)).size, 'padding should be even on both axes').toBe(1)
  // 16px icon + 2×3px padding = 22, under the row's 21.75px line box + padding.
  expect(parseFloat(pad[0])).toBeLessThanOrEqual(3)

  // The row's padding is 5px vertical but 6px horizontal, so without a pull-back
  // the button sits a pixel further from the right edge than from the top and
  // bottom. The negative margin is what makes the gap read the same on all three
  // sides it is near; it must be exactly that 1px difference.
  const rowPad = declarations('.row', 'padding')[0].split(/\s+/).map(parseFloat)
  expect(declarations('.zoom', 'margin-right')).toEqual([
    `${rowPad[0] - rowPad[1]}px`,
  ])
})

/**
 * The line box is a whole number of pixels. `line-height: 1.5` on a 14.5px font
 * gives 21.75, and that quarter pixel has to land on one side or the other —
 * it fell into the bottom of the editor's box, which sat 2px from the row's top
 * and 2.25px from its bottom. Everything vertical in a row divides from this
 * number, so a fraction here reappears as an off-centre bullet or checkbox.
 */
test('the row line box divides evenly', () => {
  for (const rule of ['.label', '.label-input']) {
    const [lh] = declarations(rule, 'line-height')
    expect(lh, `${rule} should set a whole-pixel line-height`).toMatch(/^\d+px$/)
  }
  // Both must agree, or the text moves when a row enters edit mode.
  expect(declarations('.label', 'line-height')).toEqual(
    declarations('.label-input', 'line-height'),
  )
})
