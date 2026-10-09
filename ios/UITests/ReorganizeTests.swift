import XCTest

/// features/reorganize.md: long-press a row's bullet and drag it, and the row
/// moves there. Three goes above One; the order is read back from the Worker.
@MainActor
final class ReorganizeTests: XCTestCase {
    private var project: String?

    override func tearDown() async throws {
        if let project { try await LocalAPI.remove(project) }
    }

    func testDraggingABulletMovesItsRow() async throws {
        let name = "drive reorganize " + String(UUID().uuidString.prefix(6)).lowercased()
        let project = try await LocalAPI.makeProject(name, tasks: ["One", "Two", "Three"])
        self.project = project
        let one = try await LocalAPI.child(of: project, text: "One")
        let three = try await LocalAPI.child(of: project, text: "Three")

        let app = XCUIApplication()
        app.launch()
        app.buttons["Home"].tap()
        let card = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
        try need(card.waitForExistence(timeout: 10),
            "Home doesn't show \"\(name)\". Check that the app reached the local Worker (ios/build/drive.log), then HomeCard in OutlineView.swift.")
        card.tap()

        let fromBox = app.buttons["checkbox \(three)"]
        let toBox = app.buttons["checkbox \(one)"]
        try need(fromBox.waitForExistence(timeout: 5) && toBox.exists,
            "\"\(name)\" opened without its rows' checkboxes. Check .accessibilityIdentifier(\"checkbox <id>\") in OutlineView.swift.")

        // A leaf's bullet isn't an accessibility element, so it's found as the
        // column just left of the checkbox: the box's frame starts 9.5pt into
        // the bullet's 32pt column.
        let bulletX = -12.0
        let from = fromBox.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.5))
            .withOffset(CGVector(dx: bulletX, dy: 0))
        // The top edge of One's row, at the same depth.
        let to = toBox.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0.1))
            .withOffset(CGVector(dx: bulletX, dy: 0))
        from.press(forDuration: 0.6, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.4)

        let want = ["Three", "One", "Two"]
        var order: [String] = []
        for _ in 0..<20 where order != want {
            order = try await LocalAPI.children(of: project)
            if order != want { try await Task.sleep(for: .milliseconds(250)) }
        }
        try need(order == want,
            "After dragging Three's bullet to the top, the Worker's order is \(order), not \(want). Check armGesture and the carry in ReorderDrag.swift, then the move op.")

        print("✓ dragged Three's bullet above One; the order is now \(want.joined(separator: ", "))")
    }
}
