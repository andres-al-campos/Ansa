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

  // Whatever it does to the width, the colour has to stay the bullet's own.
  expect(declarations('.bullet.parent.collapsed::before', 'border-color')).toEqual([
    'var(--bullet-ring)',
  ])
})

test('both surround forms are tinted on a drop target, and so is the dot', () => {
  // Expanded draws a border, collapsed draws a fill, and a leaf has no surround
  // at all — so the dot is the only mark every state shares.
  expect(declarations('.row.drop-into .bullet::before', 'border-color')).toEqual(['var(--brass)'])
  expect(declarations('.row.drop-into .bullet.parent.collapsed::before', 'background')).toEqual([
    'var(--brass)',
  ])
  expect(declarations('.row.drop-into .bullet::after', 'background')).toEqual(['var(--brass)'])
})

test('the collapsed drop rule outranks the expanded ring it overrides', () => {
  // `.bullet.collapsed::before` ties with `.bullet.parent::before` on
  // specificity, and the loser of a tie is whichever comes first. Naming all
  // three classes wins outright instead of depending on rule order.
  expect(css).toContain('.row.drop-into .bullet.parent.collapsed::before')
  expect(css).not.toMatch(/\.row\.drop-into \.bullet\.collapsed::before/)
})
