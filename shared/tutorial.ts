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

  ['done', 't', 'Tick this off — click the circle on the left', false],
  ['done1', 'done', 'Ticking a parent ticks everything under it. Try it on "Tick this off".', false],

  ['edit', 't', 'Rename me — click the text and type', false],
  ['edit1', 'edit', 'Enter starts a new task below. Escape stops editing.', false],

  ['nest', 't', 'Make me a sub-task — press Tab', false],
  ['nest1', 'nest', 'Shift-Tab moves it back out again.', false],
  ['nest2', 'nest', 'Drag a bullet to move a task and everything under it.', false],

  ['fold', 't', 'Collapse me — click my bullet', false],
  ['fold1', 'fold', 'Hidden. Click the bullet again to bring this back.', false],
  ['fold2', 'fold', 'Useful once a project gets long enough to scroll.', false],

  ['zoom', 't', 'Zoom into me — click my text, then the title', false],
  ['zoom1', 'zoom', 'Now this is the whole screen. Everything else is still there.', false],
  ['zoom2', 'zoom', 'Zooming is how a big tree stays workable.', false],

  ['claude', 't', 'Ask Claude to add tasks here', false],
  ['claude1', 'claude', 'Ansa has an MCP server, so Claude can read and edit this tree.', false],
  ['claude2', 'claude', 'Changes show up live — no refresh.', false],

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
