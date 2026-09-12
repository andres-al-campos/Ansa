import { newId } from './tree'
import type { Tree } from './tree'

/**
 * The one project a brand-new account starts with.
 *
 * Separate from seedTree() on purpose. That one is a *fixture*: its lopsided
 * shape is what forty-odd tests assert against, and it's filler pretending to
 * be someone's real data. This one is content — every row teaches a feature by
 * being the thing you practise it on, so working through the list and deleting
 * it as you go is the tutorial.
 *
 * Kept to one project so a new account looks empty-ish rather than furnished:
 * the first real thing you add sits next to it, not buried under three fake
 * projects you have to clear out first.
 */
// The 5th field collapses a section by default. The tour opens as one screen: a
// welcome node explaining what Ansa is for, then a short list of section heads
// you expand as you reach them. The welcome node stays open so its line shows.
// Each feature section teaches the touch gesture; the keyboard shortcuts live in
// their own section at the end, so the feature rows read the same on phone and
// desktop and nothing on a phone mentions keys it doesn't have.
const SPEC: Array<[string, string | null, string, boolean, boolean?]> = [
  ['t', null, 'Welcome to Ansa', false],
  ['t0', 't', 'Break work down until each piece is small enough to just do. Zoom in to see only what you are on, then zoom back out.', false],
  ['t1', 't', 'Each section below is folded. Tap its bullet to open it.', false],

  ['done', 't', 'Checking off', false, true],
  ['done1', 'done', 'Tap the checkbox to mark a task done. Its sub-tasks get checked too.', false],

  ['edit', 't', 'Editing', false, true],
  ['edit1', 'edit', 'Tap the text of a task to edit it.', false],

  ['nest', 't', 'Sub-tasks', false, true],
  ['nest1', 'nest', 'A task can hold sub-tasks, and those can hold their own.', false],
  ['nest2', 'nest', 'Press and hold a task, then drop it onto another to file it under that one.', false],

  ['move', 't', 'Moving', false, true],
  ['move1', 'move', 'Press and hold a task, then drop it in the gap where you want it.', false],
  ['move2', 'move', 'A task carries its sub-tasks with it.', false],

  ['zoom', 't', 'Zooming', false, true],
  ['zoom1', 'zoom', 'Zooming makes one task the whole screen. Everything else is still there.', false],
  ['zoom2', 'zoom', 'Swipe a task right to zoom in. On desktop, click its bullet.', false],
  ['zoom3', 'zoom', 'The path along the top takes you back out.', false],

  ['del', 't', 'Deleting', false, true],
  ['del1', 'del', 'Swipe a task left to delete it. Its sub-tasks go with it.', false],
  ['del2', 'del', 'Nothing is lost. It goes to the Trash, and you can restore it.', false],

  ['sync', 't', 'Everywhere at once', false, true],
  ['sync1', 'sync', 'The same tree is live on your phone and in the browser at once.', false],
  ['sync2', 'sync', 'Ansa has an MCP server, so an agent can read and edit it too.', false],

  ['keys', 't', 'Keyboard shortcuts', false, true],
  ['keys1', 'keys', 'Return adds a task. Ctrl-D (Cmd-D) checks one off.', false],
  ['keys2', 'keys', 'Tab nests a task, Shift-Tab pulls it back out.', false],
  ['keys3', 'keys', 'Alt with up or down arrow moves a task.', false],
  ['keys4', 'keys', 'Ctrl-Z (Cmd-Z) undoes, Shift added redoes.', false],
  ['keys5', 'keys', 'While editing: Return saves, Escape cancels, Ctrl-Backspace (Cmd-Backspace) deletes.', false],
]

/**
 * A fresh tutorial project.
 *
 * Mints new ids on every call for the same reason seedTree() does: node ids are
 * unique across the whole table, so two accounts starting the same literal ids
 * would collide on the primary key. See newId().
 */
export function tutorialTree(): Tree {
  const now = Date.now()
  const fresh = new Map(SPEC.map(([id]) => [id, newId()]))
  return SPEC.map(([id, parentId, text, done, collapsed], i) => ({
    id: fresh.get(id)!,
    parentId: parentId === null ? null : fresh.get(parentId)!,
    text,
    done,
    order: i,
    collapsed: collapsed ?? false,
    createdAt: now + i,
  }))
}
