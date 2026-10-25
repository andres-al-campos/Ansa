import XCTest

/// dev/features/get-around.md: fold a branch with its bullet and unfold it, zoom
/// into a task with a right swipe and come back with Back, and reopen the app
/// on the project you were in.
@MainActor
final class GetAroundTests: XCTestCase {
    private var project: String?

    override func tearDown() async throws {
        if let project { try await LocalAPI.remove(project) }
    }

    func testFoldZoomBackAndReopen() async throws {
        let word = String(UUID().uuidString.prefix(6)).lowercased()
        let name = "drive get-around \(word)"
        let project = try await LocalAPI.makeProject(name, tasks: ["Parent"])
        self.project = project
        let parent = try await LocalAPI.child(of: project, text: "Parent")
        try await LocalAPI.add(["Child"], under: parent)

        let app = XCUIApplication()
        app.launch()
        app.buttons["Home"].tap()
        let card = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
        try need(card.waitForExistence(timeout: 10),
            "Home doesn't show \"\(name)\". Check that the app reached the local Worker (ios/build/drive.log), then HomeCard in OutlineView.swift.")
        card.tap()

        let child = app.buttons["Child"]
        try need(child.waitForExistence(timeout: 5),
            "\"\(name)\" opened without Parent's Child showing. Check the row list in OutlineView.swift.")

        // Fold, then unfold.
        let bullet = app.buttons["bullet \(parent)"]
        try need(bullet.waitForExistence(timeout: 5),
            "Parent has no bullet to fold with. It's the Bullet in rowContent, OutlineView.swift; check it keeps .accessibilityIdentifier(\"bullet <id>\").")
        bullet.tap()
        try need(child.waitForNonExistence(timeout: 5),
            "Tapping Parent's bullet left Child showing. Check bulletGesture and onCollapse in OutlineView.swift.")
        let folded = try await settles(parent, collapsed: true)
        try need(folded, "Parent folded on screen but the Worker never saw it. Check the toggleCollapsed op in OutlineView.swift.")
        bullet.tap()
        try need(child.waitForExistence(timeout: 5),
            "Tapping Parent's bullet again didn't bring Child back. Check bulletGesture and onCollapse in OutlineView.swift.")

        // Zoom in, then Back.
        app.buttons["Parent"].fullSwipe(left: false, in: app)
        try need(app.buttons["More"].firstMatch.waitForExistence(timeout: 5)
                && !app.buttons["checkbox \(parent)"].exists,
            "A full right swipe on Parent didn't zoom into it. Check onZoom in RowSwipeView.swift.")
        app.buttons["Back"].tap()
        try need(app.buttons["checkbox \(parent)"].waitForExistence(timeout: 5),
            "Back from Parent didn't return to \(name). Check the back stack in OutlineView.swift.")

        // Reopen where it was.
        app.terminate()
        app.launch()
        try need(app.buttons["checkbox \(parent)"].waitForExistence(timeout: 10),
            "Reopening the app didn't land on \(name), the last place open. Check TreeOps.resumeScope in AnsaCore and where OutlineView.swift calls it.")

        print("✓ folded and unfolded Parent, zoomed in and came Back, and reopened on \(name)")
    }

    private func settles(_ id: String, collapsed want: Bool) async throws -> Bool {
        for _ in 0..<20 {
            if try await LocalAPI.node(id)?["collapsed"] as? Bool == want { return true }
            try await Task.sleep(for: .milliseconds(250))
        }
        return false
    }
}
