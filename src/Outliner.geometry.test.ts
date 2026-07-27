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

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.css'), 'utf8')

/** The value of one declaration inside the first rule matching `selector`. */
function declaration(selector: string, property: string): string {
  const rule = css.match(
    new RegExp(`^\\${selector}\\s*\\{([^}]*)\\}`, 'm'),
  )
  if (!rule) throw new Error(`No CSS rule for "${selector}" — did the selector get renamed?`)
  const decl = rule[1].match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`))
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

test('the gutter and row gap match what the guide offset assumes', () => {
  expect(px('.gutter', 'width')).toBe(GEOMETRY.GUTTER)
  expect(px('.row', 'gap')).toBe(GEOMETRY.ROW_GAP)
})

test('the guide is centred on the bullet, not hung off its left edge', () => {
  // A 1px line placed at `left: GUIDE_X0` spans X→X+1 and so centres half a
  // pixel right of the bullet. The offset only cancels if GUIDE_W is the width
  // CSS actually draws, which is what this pins.
  expect(px('.guide', 'width')).toBe(GEOMETRY.GUIDE_W)
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
