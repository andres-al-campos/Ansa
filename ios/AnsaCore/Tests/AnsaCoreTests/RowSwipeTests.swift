import Testing
import Foundation
@testable import AnsaCore

@Suite("Row swipe")
struct RowSwipeTests {
    let w: CGFloat = 393  // iPhone 16 portrait

    @Test("A still finger names no action")
    func noActionAtRest() {
        #expect(RowSwipe.action(for: 0) == nil)
    }

    @Test("Direction follows the finger rather than latching")
    func directionFollows() {
        #expect(RowSwipe.action(for: 40) == .zoom)
        #expect(RowSwipe.action(for: -40) == .delete)
    }

    @Test("Short pulls track the finger one to one")
    func undampedBeforeCommit() {
        #expect(RowSwipe.offset(for: 50, screenWidth: w) == 50)
        #expect(RowSwipe.offset(for: -50, screenWidth: w) == -50)
    }

    @Test("Pulls past the commit point are damped, not clamped")
    func dampedPastCommit() {
        let commit = w * RowSwipe.commitFraction
        let far = RowSwipe.offset(for: commit + 100, screenWidth: w)
        #expect(far > commit)              // still moving
        #expect(far < commit + 100)        // but not one to one
    }

    @Test("Damping is symmetric in both directions")
    func dampingSymmetric() {
        let a = RowSwipe.offset(for: 200, screenWidth: w)
        let b = RowSwipe.offset(for: -200, screenWidth: w)
        #expect(a == -b)
    }

    @Test("Arming happens at a quarter of the screen, both ways")
    func armsAtQuarter() {
        let commit = w * RowSwipe.commitFraction
        #expect(!RowSwipe.isArmed(commit - 1, screenWidth: w))
        #expect(RowSwipe.isArmed(commit, screenWidth: w))
        #expect(!RowSwipe.isArmed(-(commit - 1), screenWidth: w))
        #expect(RowSwipe.isArmed(-commit, screenWidth: w))
    }

    @Test("A zero-width screen never arms")
    func zeroWidthNeverArms() {
        #expect(!RowSwipe.isArmed(500, screenWidth: 0))
    }

    // The regression this suite exists for. A Button inside a List keeps its
    // tap through a sibling drag, so a cancelled swipe kept opening the editor
    // on the row it had just let go of.
    @Test("A tap during the spring back is the swipe's tail, not a tap")
    func tapRefusedDuringReturn() {
        #expect(!RowSwipe.acceptsTap(elapsed: 0))
        #expect(!RowSwipe.acceptsTap(elapsed: 0.1))
        #expect(!RowSwipe.acceptsTap(elapsed: RowSwipe.tapDeafness - 0.01))
    }

    @Test("A tap after the row has landed is a tap")
    func tapAcceptedAfterReturn() {
        #expect(RowSwipe.acceptsTap(elapsed: RowSwipe.tapDeafness))
        #expect(RowSwipe.acceptsTap(elapsed: 1))
    }

    @Test("A tap with no swipe behind it is always a tap")
    func tapAcceptedWithoutSwipe() {
        #expect(RowSwipe.acceptsTap(elapsed: nil))
    }

    // Guards the constant against its own comment, which has drifted before.
    @Test("Commit is a quarter and damping is not")
    func constantsMatchTheirComments() {
        #expect(RowSwipe.commitFraction == 0.25)
        #expect(RowSwipe.pastCommit == 0.35)
    }
}
