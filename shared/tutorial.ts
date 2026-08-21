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
const SPEC: Array<[string, string | null, string, boolean]> = [
  ['t', null, 'Start here — a tour of Ansa', false],

  ['done', 't', 'Ticking off', false],
  ['done1', 'done', 'Ticking a task ticks everything under it too.', false],
  ['done2', 'done', 'Tap or click the square on the left. Try it on this one.', false],

  ['edit', 't', 'Renaming', false],
  ['edit1', 'edit', 'Tap or click the text and type. This row is safe to practise on.', false],
  ['edit2', 'edit', 'On the phone: Return saves and closes. New tasks go in the field at the bottom.', false],
  ['edit3', 'edit', 'On desktop: Return saves and opens a new task below. Escape closes without one.', false],

  ['nest', 't', 'Sub-tasks', false],
  ['nest1', 'nest', 'Anything can hold tasks underneath it, as deep as you like.', false],
  ['nest2', 'nest', 'On the phone: drag a bullet sideways — right to tuck it under the task above, left to pull it out.', false],
  ['nest3', 'nest', 'On desktop: Tab makes a task a sub-task, Shift-Tab moves it back out.', false],
  ['nest4', 'nest', 'Both: drag a bullet to move a task and everything under it.', false],

  ['fold', 't', 'Collapsing', false],
  ['fold1', 'fold', 'Folding a task hides its sub-tasks without deleting them.', false],
  ['fold2', 'fold', 'Tap or click the bullet of anything with sub-tasks. Try it here — this row will vanish.', false],
  ['fold3', 'fold', 'Useful once a project gets long enough to scroll.', false],

  ['zoom', 't', 'Zooming', false],
  ['zoom1', 'zoom', 'Zooming makes one task the whole screen. Everything else is still there.', false],
  ['zoom2', 'zoom', 'On the phone: swipe a task left, then tap Zoom in. The arrow at the top left comes back out.', false],
  ['zoom3', 'zoom', 'On desktop: click a task, then click the title above the list.', false],
  ['zoom4', 'zoom', 'Both: this is how a big tree stays workable.', false],

  ['sync', 't', 'Everywhere at once', false],
  ['sync1', 'sync', 'The phone and the browser show the same tree. Edits appear on the other one live.', false],
  ['sync2', 'sync', 'Ansa has an MCP server too, so Claude can read and edit this tree.', false],

  ['last', 't', 'Delete this whole project when you are done', false],
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
  return SPEC.map(([id, parentId, text, done], i) => ({
    id: fresh.get(id)!,
    parentId: parentId === null ? null : fresh.get(parentId)!,
    text,
    done,
    order: i,
    collapsed: false,
    createdAt: now + i,
  }))
}
