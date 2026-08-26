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
 */
test('the drag handles show a grab cursor', () => {
  // A leaf has no fold, so its resting cursor is the grab. A parent rests on
  // the pointer because a click folds it; both go to grabbing on the press.
  expect(declarations('.bullet:not(.folds)', 'cursor')).toEqual(['grab'])
  expect(declarations('.bullet:active', 'cursor')).toEqual(['grabbing'])
  expect(declarations('.rail.projects .proj:active', 'cursor')).toEqual(['grabbing'])
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
