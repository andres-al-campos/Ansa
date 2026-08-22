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
