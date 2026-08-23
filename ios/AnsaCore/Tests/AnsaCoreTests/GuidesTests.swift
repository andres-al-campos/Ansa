/// The depth guides are drawn from visible rows alone, so these cases are all
/// about where a run of deeper rows starts and stops — including the ones that
/// look like they should produce a line and must not.

import Testing
@testable import AnsaCore

private func rows(_ depths: [Int]) -> [TreeOps.HitRow] {
    depths.enumerated().map { .init(id: "n\($0.offset)", depth: $0.element) }
}

@Suite("Depth guides")
struct GuidesTests {

    @Test("a leaf-only list draws nothing")
    func flat() {
        #expect(TreeOps.guides(rows([0, 0, 0])).isEmpty)
    }

    @Test("a parent's guide spans its children, not itself")
    func spansChildren() {
        let g = TreeOps.guides(rows([0, 1, 1, 0]))
        #expect(g == [.init(parent: "n0", depth: 0, first: 1, last: 2)])
    }

    @Test("a guide reaches the last descendant, not the last child")
    func reachesDeepest() {
        // 0 / 1 / 2 — the depth-0 guide covers both deeper rows, because the
        // grandchild is still inside its subtree.
        let g = TreeOps.guides(rows([0, 1, 2, 0]))
        #expect(g.first == .init(parent: "n0", depth: 0, first: 1, last: 2))
    }

    @Test("nested parents each get their own guide")
    func nested() {
        let g = TreeOps.guides(rows([0, 1, 2]))
        #expect(g == [
            .init(parent: "n0", depth: 0, first: 1, last: 2),
            .init(parent: "n1", depth: 1, first: 2, last: 2),
        ])
    }

    @Test("a collapsed parent has no visible children and so no guide")
    func collapsed() {
        // Collapsing is expressed by the children simply not being in the
        // visible list, which is the only thing this sees.
        #expect(TreeOps.guides(rows([0, 0])).isEmpty)
    }

    @Test("a subtree scrolled in from above still gets a line")
    func partialFromAbove() {
        // The parent row is off screen, so the run of deeper rows has no
        // parent in the list and draws no guide of its own — the view clips
        // the ancestor's line instead of inventing one here.
        #expect(TreeOps.guides(rows([1, 1])).isEmpty)
    }

    @Test("a run ends where depth returns to the parent's level")
    func endsAtSibling() {
        let g = TreeOps.guides(rows([0, 1, 0, 1]))
        #expect(g == [
            .init(parent: "n0", depth: 0, first: 1, last: 1),
            .init(parent: "n2", depth: 0, first: 3, last: 3),
        ])
    }

    @Test("an outdent past the parent closes the guide")
    func outdentCloses() {
        // 1 / 2 / 0: the depth-1 row's guide stops before the depth-0 row,
        // which is shallower than its own parent would be.
        let g = TreeOps.guides(rows([1, 2, 0]))
        #expect(g == [.init(parent: "n0", depth: 1, first: 1, last: 1)])
    }
}

/// Where a horizontal separator has to stop so it never cuts a vertical guide.
@Suite("innermostGuideDepth")
struct InnermostGuideDepthTests {

    func depths(_ ds: [Int]) -> (Int) -> Int? {
        let g = TreeOps.guides(rows(ds))
        return { TreeOps.innermostGuideDepth(g, below: $0) }
    }

    @Test("a flat list has nothing to stop at")
    func flat() {
        let at = depths([0, 0, 0])
        #expect(at(0) == nil)
        #expect(at(1) == nil)
    }

    /// The case the separator got wrong on screen: directly under a parent its
    /// own guide has not started, so the answer is its ancestor's or nothing.
    @Test("a parent's own guide does not cross the gap beneath it")
    func gapUnderParent() {
        // n0(0) n1(1) n2(2) n3(2) n4(1)
        let at = depths([0, 1, 2, 2, 1])
        #expect(at(0) == nil)   // under n0: n0's guide starts at row 1
        #expect(at(1) == 0)     // under n1: n0's guide runs; n1's starts at 2
        #expect(at(2) == 1)     // between the two depth-2 rows
        // n1's guide ends *at* row 3, so it does not run below it — only n0's
        // does. This is the outdent boundary, and the separator steps back out
        // to match.
        #expect(at(3) == 0)
    }

    @Test("outdenting back to the root leaves nothing crossing")
    func outdent() {
        // n0(0) n1(1) n2(0)
        let at = depths([0, 1, 0])
        #expect(at(0) == nil)
        #expect(at(1) == nil)   // n0's guide ends at row 1, so it is not below it
    }

    @Test("the innermost of several nested guides wins")
    func innermost() {
        // n0(0) n1(1) n2(2) n3(3) n4(3)
        let at = depths([0, 1, 2, 3, 3])
        #expect(at(3) == 2)
    }
}
