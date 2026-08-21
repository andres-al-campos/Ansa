# Designs

Mockups and the thinking behind them, kept because the reasoning is the part
that gets lost. The app shows what was decided; these show what was considered
and why one option won.

Open the HTML files in a browser. They are self-contained and render the app's
real token values, so the marks in them are true to what ships rather than
approximations.

Named `YYYY-MM-DD-subject.html`, so the sequence reads in order.

## 2026-08-19 — iOS row anatomy

The task row for the phone: which control lives where, and which gesture does
what. Written after the sync work landed, before any UI refinement started.

**What changed and why:**

- **Square checkbox, circle bullet.** They were both circles differing by fill
  and colour — the same two channels that also carry *state*, so a ticked box
  and a collapsed-parent bullet converged on the same mark. Shape is
  categorical: it says what a control *is*, independent of state.
- **The per-row count came off.** The web never had it. Progress there is one
  bar for the whole scope, in the header. Repeating a number on every parent row
  was the phone diverging, not the phone catching up.
- **The chevron came off.** The bullet's solid disc already means collapsed.
- **Columns sorted by cost of a mis-tap.** The left edge is where a thumb
  brushes while scrolling one-handed, so it holds only what is undone by
  repeating the tap. `setDone` is symmetric through the whole subtree
  (`shared/tree.ts`), so checking is genuinely cheap to reverse even on a
  parent — which is what makes it safe to leave there.
- **Zoom moved to a left swipe on the row.** It was the awkward case: cheap to
  undo but disorienting, since the whole screen replaces itself. Swipe-to-reveal
  cannot fire by accident, because committing needs either a second tap or a
  deliberate push past the threshold.
- **Capture moved to the bottom.** `Sources/OutlineView.swift` argued for the
  top so an idea could be caught without scrolling first. Bottom satisfies that
  equally well and adds thumb reach plus keyboard adjacency — the field no
  longer jumps across the screen when focused.
- **The header scrolls away.** Pinning both ends squeezed an already short
  screen. Unpinning the breadcrumb and bar means only the capture bar is fixed,
  which removed the squeeze rather than trading against it.

**Rejected, and why it matters:**

- **Swipe to indent/outdent.** It was in the app already. Outdenting a top-level
  row, or indenting into a collapsed parent, makes the row vanish with nothing
  showing where it went — from a gesture easy to trigger by accident. Dragging
  replaces it, which also frees the horizontal axis that delete and nesting were
  both competing for.
- **Sidebar on the right.** Proposed to keep the left edge free for a back
  swipe, then dropped: sidebars live on the left, and the conflict was imaginary
  once back and zoom were assigned opposite directions.
- **Nesting the checkbox inside the drag ring.** Two tap targets in one place,
  where a mis-hit means dragging a subtree instead of ticking a box.

**Still open:**

- The solid disc is now the only cue that children are hidden — the chevron and
  the count both went. True on the web too, but the phone has no hover and
  narrower rows. If it reads too quietly, make the collapsed state more
  emphatic rather than restoring the number.
- Depth is carried entirely by left padding and the nesting guides, which makes
  the guides load-bearing rather than decorative.
- `shared/tutorial.ts` seeds one tree for both clients, and its copy is written
  for the web ("press Tab", "click the circle"). The phone likely wants a
  device-neutral tutorial plus a one-time gesture card. Worth doing once the
  gestures actually ship, so the card documents what exists.

## 2026-08-19 — Depth without guides

Four ways for a row to say how deep it sits: the guides that ship today, a
surface tint, a leading bar, and type weight. Written against the open question
the row-anatomy notes left — that depth rests entirely on padding and guides.

**What the phone screenshot forced:** rows wrap to three lines, so the text's
left edge moves more from wrapping than from nesting. Any cue living in the
horizontal gap fights that. Tint and the leading bar mark the row itself, so
they don't.

**Where it landed:** tint is the cheapest and degrades best — once the shades
stop being separable, the boundary between two rows still says which is deeper.
The leading bar keeps more precision but adds a third coloured mark to a row
that already has a checkbox and a bullet. Type weight is free and stacks with
either rather than shipping alone.

Nothing here fixes deep trees. That is zoom's job, which is also how Workflowy's
mobile app answers it — it barely renders depth, because you are never more than
a level or two from your scope.
