/// The edge cases here are the ones that make auto-scroll feel broken rather
/// than absent: stalling at a boundary, and running past the ends of the list.

import Testing
@testable import AnsaCore

/// Ten 40pt rows from y=0, in a 200pt viewport scrolled to `offset`.
private func boxes(offset: Double = 0) -> [TreeOps.RowBox] {
    (0..<10).map { .init(id: "n\($0)", top: Double($0) * 40 - offset, height: 40) }
}

/// Every row, measured or not. `List` renders only a window of these.
private let order: [NodeId] = (0..<10).map { "n\($0)" }

private let top = 0.0
private let bottom = 200.0

@Suite("Auto-scroll during a drag")
struct DragScrollTests {

    @Test("a finger in the middle scrolls nothing")
    func middle() {
        #expect(TreeOps.dragScroll(y: 100, top: top, bottom: bottom, order: order, boxes: boxes()) == .none)
    }

    @Test("near the bottom edge it reaches for the next row down")
    func downwards() {
        // Rows 0-4 are fully visible in 0...200; row 5 is the next one.
        #expect(TreeOps.dragScroll(y: 190, top: top, bottom: bottom, order: order, boxes: boxes())
            == .down("n5"))
    }

    @Test("near the top edge it reaches for the row above")
    func upwards() {
        // Scrolled down two rows, so rows 2+ are on screen and row 1 is above.
        #expect(TreeOps.dragScroll(y: 10, top: top, bottom: bottom, order: order, boxes: boxes(offset: 80))
            == .up("n1"))
    }

    @Test("at the very top there is nothing above to scroll to")
    func topOfList() {
        #expect(TreeOps.dragScroll(y: 10, top: top, bottom: bottom, order: order, boxes: boxes()) == .none)
    }

    @Test("at the very bottom there is nothing below to scroll to")
    func bottomOfList() {
        // Scrolled to the end: row 9 ends exactly at the viewport bottom.
        #expect(TreeOps.dragScroll(y: 190, top: top, bottom: bottom, order: order, boxes: boxes(offset: 200))
            == .none)
    }

    @Test("an empty list scrolls nothing")
    func empty() {
        #expect(TreeOps.dragScroll(y: 190, top: top, bottom: bottom, order: order, boxes: []) == .none)
    }

    @Test("the step is measured from the edge, not from the finger")
    func doesNotStall() {
        // A finger parked at 195 sits over row 4, which is fully visible. If the
        // step were relative to the finger's own row it would ask for row 4 and
        // never move; it must ask for row 5.
        let step = TreeOps.dragScroll(y: 195, top: top, bottom: bottom, order: order, boxes: boxes())
        #expect(step == .down("n5"))
    }

    /// The bug this guards: `boxes` holds only what `List` has rendered, and
    /// `List` recycles cells as it scrolls. Once the drag has moved a screenful
    /// the row to bring in has never been measured, so a step taken *within*
    /// `boxes` runs off its own end and returns `.none` — auto-scroll works for
    /// a moment, then stops while the timer keeps ticking.
    @Test("it keeps scrolling once the target row is no longer measured")
    func beyondTheMeasuredWindow() {
        // Scrolled to row 5; only rows 5-9 have ever been rendered.
        let window = Array(boxes(offset: 200)[5...])
        #expect(TreeOps.dragScroll(
            y: 10, top: top, bottom: bottom, order: order, boxes: window) == .up("n4"))
    }

    @Test("an unmeasured order still stops at the ends")
    func endsWithPartialBoxes() {
        // The window starts at row 0, so there is genuinely nothing above it.
        let window = Array(boxes()[0..<5])
        #expect(TreeOps.dragScroll(
            y: 10, top: top, bottom: bottom, order: order, boxes: window) == .none)
    }

    @Test("a partly clipped row at the edge does not count as visible")
    func partialRow() {
        // Offset 20: row 0 is clipped at the top, so the first fully visible
        // row is 1 and the one to bring in is 0.
        #expect(TreeOps.dragScroll(y: 10, top: top, bottom: bottom, order: order, boxes: boxes(offset: 20))
            == .up("n0"))
    }
}

@Suite("Edge-scroll pace")
struct EdgeScrollPaceTests {

    /// Steps taken over `seconds` of ticks every 10ms in the band.
    private func steps(_ pace: inout EdgeScrollPace, from start: Double, for seconds: Double) -> Int {
        var count = 0
        var now = start
        while now < start + seconds - 1e-9 {
            if pace.step(.down("n5"), at: now) != nil { count += 1 }
            now += 0.01
        }
        return count
    }

    @Test("a drag that starts in the band does not scroll")
    func startsInside() {
        var pace = EdgeScrollPace()
        #expect(steps(&pace, from: 0, for: 2) == 0)
    }

    @Test("after leaving the band, entering it scrolls")
    func reenters() {
        var pace = EdgeScrollPace()
        #expect(pace.step(.down("n5"), at: 0) == nil)
        #expect(pace.step(.none, at: 0.1) == nil)
        #expect(pace.step(.down("n5"), at: 0.2) != nil)
    }

    @Test("the first second is slower than the next")
    func ramps() {
        var pace = EdgeScrollPace()
        _ = pace.step(.none, at: 0)
        let first = steps(&pace, from: 0.01, for: 1)
        let second = steps(&pace, from: 1.01, for: 1)
        // About 2→7 rows a second averages ~4.5 over the ramp, then 7 flat.
        #expect((3...6).contains(first))
        #expect((6...8).contains(second))
        #expect(first < second)
    }

    @Test("leaving the band restarts the ramp")
    func restarts() {
        var pace = EdgeScrollPace()
        _ = pace.step(.none, at: 0)
        _ = steps(&pace, from: 0.01, for: 2)
        _ = pace.step(.none, at: 2.05)
        #expect(steps(&pace, from: 2.1, for: 0.5) <= 3)
    }
}
