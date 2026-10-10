import XCTest

extension XCUIElement {
    /// A full swipe to the far edge, held there, the way a thumb commits a
    /// row's action. XCUITest's own swipeLeft/Right stop short of committing.
    func fullSwipe(left: Bool, in app: XCUIApplication) {
        // A right swipe starts clear of the screen's left 64pt, which the
        // back swipe claims (`backClaim` in OutlineView.swift).
        let start = coordinate(withNormalizedOffset: CGVector(dx: left ? 0.9 : 0.3, dy: 0.5))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: left ? 0.02 : 0.98, dy: 0))
            .withOffset(CGVector(dx: 0, dy: start.screenPoint.y))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .default, thenHoldForDuration: 0.1)
    }
}
