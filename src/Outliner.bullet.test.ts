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

/** The body of the first rule whose selector matches exactly, pseudos included. */
function body(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = css.match(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm'))
  if (!rule) throw new Error(`No CSS rule for "${selector}" — did the selector get renamed?`)
  return rule[1]
}

/** Every declaration of `property` in a rule, longhand only (not `border-color`
 *  when asking for `border`). */
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
  for (const token of ['--mark', '--mark-hover', '--mark-dot', '--mark-lift']) {
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

test('the collapsed drop rule outranks the expanded ring it overrides', () => {
  // `.bullet.collapsed::before` ties with `.bullet.parent::before` on
  // specificity, and the loser of a tie is whichever comes first. Naming all
  // three classes wins outright instead of depending on rule order.
  expect(css).toContain('.row.drop-into .bullet.parent.collapsed::before')
  expect(css).not.toMatch(/\.row\.drop-into \.bullet\.collapsed::before/)
})
