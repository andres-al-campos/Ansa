/// The edge cases here are the ones that make auto-scroll feel broken rather
/// than absent: stalling at a boundary, and running past the ends of the list.

import Testing
@testable import AnsaCore

/// Ten 40pt rows from y=0, in a 200pt viewport scrolled to `offset`.
private func boxes(offset: Double = 0) -> [TreeOps.RowBox] {
    (0..<10).map { .init(id: "n\($0)", top: Double($0) * 40 - offset, height: 40) }
}

private let top = 0.0
private let bottom = 200.0

@Suite("Auto-scroll during a drag")
struct DragScrollTests {

    @Test("a finger in the middle scrolls nothing")
    func middle() {
        #expect(TreeOps.dragScroll(y: 100, top: top, bottom: bottom, boxes: boxes()) == .none)
    }

    @Test("near the bottom edge it reaches for the next row down")
    func downwards() {
        // Rows 0-4 are fully visible in 0...200; row 5 is the next one.
        #expect(TreeOps.dragScroll(y: 190, top: top, bottom: bottom, boxes: boxes())
            == .down("n5"))
    }

    @Test("near the top edge it reaches for the row above")
    func upwards() {
        // Scrolled down two rows, so rows 2+ are on screen and row 1 is above.
        #expect(TreeOps.dragScroll(y: 10, top: top, bottom: bottom, boxes: boxes(offset: 80))
            == .up("n1"))
    }

    @Test("at the very top there is nothing above to scroll to")
    func topOfList() {
        #expect(TreeOps.dragScroll(y: 10, top: top, bottom: bottom, boxes: boxes()) == .none)
    }

    @Test("at the very bottom there is nothing below to scroll to")
    func bottomOfList() {
        // Scrolled to the end: row 9 ends exactly at the viewport bottom.
        #expect(TreeOps.dragScroll(y: 190, top: top, bottom: bottom, boxes: boxes(offset: 200))
            == .none)
    }

    @Test("an empty list scrolls nothing")
    func empty() {
        #expect(TreeOps.dragScroll(y: 190, top: top, bottom: bottom, boxes: []) == .none)
    }

    @Test("the step is measured from the edge, not from the finger")
    func doesNotStall() {
        // A finger parked at 195 sits over row 4, which is fully visible. If the
        // step were relative to the finger's own row it would ask for row 4 and
        // never move; it must ask for row 5.
        let step = TreeOps.dragScroll(y: 195, top: top, bottom: bottom, boxes: boxes())
        #expect(step == .down("n5"))
    }

    @Test("a partly clipped row at the edge does not count as visible")
    func partialRow() {
        // Offset 20: row 0 is clipped at the top, so the first fully visible
        // row is 1 and the one to bring in is 0.
        #expect(TreeOps.dragScroll(y: 10, top: top, bottom: bottom, boxes: boxes(offset: 20))
            == .up("n0"))
    }
}
