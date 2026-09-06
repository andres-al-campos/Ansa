/// Ported from `src/dropTarget.test.ts`, case for case, plus the op mapping
/// that has no TypeScript counterpart — on the web the component turns a drop
/// into an op inline, while here `dropOp` owns it.
///
/// Same reasoning as the other ported suites: the band arithmetic and the
/// gap-depth clamping are what a drag gets subtly wrong, and a phone that
/// resolves a drop differently from the browser writes an op the server applies
/// somewhere else.

import Testing
@testable import AnsaCore

/// Three rows, 32pt tall, stacked from y=0. `a` is a parent of `b`.
private func dropFixture() -> Tree {
    [
        Node(id: "a", parentId: nil, text: "a", done: false, order: 0,
             collapsed: false, createdAt: 0),
        Node(id: "b", parentId: "a", text: "b", done: false, order: 1,
             collapsed: false, createdAt: 0),
        Node(id: "c", parentId: nil, text: "c", done: false, order: 2,
             collapsed: false, createdAt: 0),
    ]
}

private let visible: [TreeOps.HitRow] = [
    .init(id: "a", depth: 0),
    .init(id: "b", depth: 1),
    .init(id: "c", depth: 0),
]

private let boxes = TreeOps.rowBoxes(visible, rowHeight: 32)

// The geometry the web component passes in, from GEOMETRY in Outliner.tsx.
// Kept at the web's values so the ported expectations mean the same thing; the
// phone's own indent is narrower and is supplied by the view.
private let guideX0 = 37.0
private let indentStep = 24.0

private func at(_ x: Double, _ y: Double, _ dragging: NodeId = "c") -> TreeOps.DropTarget? {
    TreeOps.dropTargetAt(
        x: x, y: y, dragging: dragging, tree: dropFixture(),
        visible: visible, boxes: boxes, guideX0: guideX0, indent: indentStep)
}

@Suite("The drag hit-test")
struct DropTargetTests {

    @Test("the middle of a row nests into it")
    func middleNests() {
        // Row `a` spans 0–32, so its centre is 16.
        #expect(at(100, 16)?.mode == .into)
        #expect(at(100, 16)?.id == "a")
    }

    @Test("the top and bottom of a row are insertion gaps, not nests")
    func edgesAreGaps() {
        // Above the middle band of `b` (32–64): the gap between `a` and `b`.
        #expect(at(100, 34)?.mode == .after)
        // Below it: the gap between `b` and `c`.
        #expect(at(100, 62)?.mode == .after)
    }

    @Test("nesting owns the middle half of a row")
    func bandsSplitAtQuarters() {
        // Pins `nestBand`, which the other tests probe well inside of and so
        // would not notice moving. The split is what makes the three outcomes
        // equally likely: a gap band is a quarter of the row above plus a
        // quarter of the row below, which is the same half-row of travel that
        // nesting gets in the middle. A `nestBand` above a third inverts that
        // and leaves nesting the narrowest of the three.
        //
        // Row `b` spans 32–64, so its quarters fall at 40 and 56.
        #expect(at(100, 38)?.mode == .after)  // top quarter: the gap above
        #expect(at(100, 42)?.mode == .into)  // just inside the middle
        #expect(at(100, 48)?.mode == .into)  // dead centre
        #expect(at(100, 54)?.mode == .into)  // still the middle
        #expect(at(100, 58)?.mode == .after)  // bottom quarter: the gap below
    }

    @Test("the dragged row's own slot offers to put it back")
    func ownSlotReturns() {
        // Releasing on the slim slot the lifted row still holds is a no-op
        // return, never a move — the one target that must not be confused
        // with a real drop.
        #expect(at(100, 80, "c") == TreeOps.DropTarget(id: "c", mode: .return))
    }

    @Test("a row is never nested into its own descendant")
    func noCycles() {
        // Descendants are not drawn mid-drag, so this is belt and braces:
        // dragging `a` over its child `b` must refuse rather than build a
        // cycle.
        #expect(at(100, 48, "a") == nil)
    }

    @Test("the touch x picks the depth in a gap")
    func xPicksDepth() {
        // The gap below `b` (depth 1) spans depth 0 to depth 1: 0 outdents to
        // the root list and 1 is a sibling of `b`. Far left and far right clamp
        // to those ends, which is what the insertion line's indent shows.
        #expect(at(0, 62)?.depth == 0)
        #expect(at(500, 62)?.depth == 1)
    }

    @Test("a gap under a leaf will not nest into it")
    func leafGapStopsAtSibling() {
        // `b` has no children, so its gap tops out at `b`'s own depth. Making
        // something a child of `b` is the `into` drop — onto the row itself —
        // and nothing else, which is what keeps the gap's bands wide enough to
        // hit with a thumb. See `deepestAtGap`.
        #expect(at(9999, 62)?.depth == 1)
        #expect(at(9999, 62)?.id == "b")
    }

    @Test("a gap under a parent does offer one level deeper")
    func parentGapOffersChildDepth() {
        // `a` already has `b`, so the gap below `a` can mean "another child of
        // `a`". This is the half of the rule that survives: the offer is there
        // when the row above has demonstrated it takes children.
        #expect(at(9999, 34)?.depth == 1)
        #expect(at(9999, 34)?.id == "a")
    }

    @Test("a parent whose only child is the row in flight counts as a leaf")
    func liftedChildDoesNotCount() {
        // Dragging `b` — `a`'s only child — leaves `a` childless the moment the
        // drop lands, so the gap under `a` must not still offer "another child
        // of `a`". It would be a depth the tree cannot hold once `b` leaves.
        //
        // Probed from `a`'s own bottom quarter (24–32) rather than `b`'s top
        // quarter: `b` is the lifted row, and its whole box answers `return`.
        #expect(at(9999, 30, "b")?.depth == 0)
        #expect(at(9999, 30, "b")?.id == "a")
    }

    @Test("the shallow end is never restricted")
    func outdentAlwaysReachable() {
        // Depth 0 is offered at every gap regardless of what sits above it.
        // With the deep end now conditional, dragging left in a gap is the
        // only way to outdent, so it must always be there.
        #expect(at(0, 34)?.depth == 0)
        #expect(at(0, 62)?.depth == 0)
    }

    @Test("a touch past the last row hits nothing")
    func pastTheEndIsNil() {
        // Below every row box: no target rather than the nearest one, so
        // releasing in empty space cancels instead of dropping somewhere
        // arbitrary.
        #expect(at(100, 500) == nil)
    }
}

@Suite("A resolved drop becomes an op")
struct DropOpTests {
    private let tree = dropFixture()

    @Test("returning the row where it started writes nothing")
    func returnIsNoOp() {
        let target = TreeOps.DropTarget(id: "c", mode: .return)
        #expect(TreeOps.dropOp(tree, "c", target, scope: nil) == nil)
    }

    @Test("nesting into a row makes it that row's first child")
    func intoBecomesMoveNode() {
        let target = TreeOps.DropTarget(id: "a", mode: .into)
        #expect(
            TreeOps.dropOp(tree, "c", target, scope: nil)
                == .moveNode(id: "c", parentId: "a", index: 0))
    }

    @Test("a gap carries its chosen depth to the server")
    func gapBecomesInsertAtDepth() {
        // The depth the finger picked is what makes the drop unambiguous, so
        // it has to travel — the server cannot re-derive it from the anchor.
        let target = TreeOps.DropTarget(id: "b", mode: .after, depth: 2)
        #expect(
            TreeOps.dropOp(tree, "c", target, scope: nil)
                == .insertAtDepth(
                    id: "c", anchorId: "b", depth: 2, side: .after, scope: nil))
    }

    @Test("a gap before a row keeps the before side")
    func beforeKeepsItsSide() {
        let target = TreeOps.DropTarget(id: "a", mode: .before, depth: 0)
        #expect(
            TreeOps.dropOp(tree, "c", target, scope: nil)
                == .insertAtDepth(
                    id: "c", anchorId: "a", depth: 0, side: .before, scope: nil))
    }

    @Test("the scope travels with the op")
    func scopeIsCarried() {
        // Depth is scope-relative, so a drop resolved inside a zoomed project
        // means something different at the root. Sending the scope is what
        // keeps the server's reading the same as the phone's.
        let target = TreeOps.DropTarget(id: "b", mode: .after, depth: 1)
        #expect(
            TreeOps.dropOp(tree, "c", target, scope: "a")
                == .insertAtDepth(
                    id: "c", anchorId: "b", depth: 1, side: .after, scope: "a"))
    }
}
