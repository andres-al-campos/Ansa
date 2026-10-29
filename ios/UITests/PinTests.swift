import XCTest

/// dev/features/pin.md: pin a task from its ⋯ menu and it shows on Home's shelf;
/// open it from there and unpin it, and the shelf lets it go. Read on screen
/// and on the Worker.
@MainActor
final class PinTests: XCTestCase {
    private var project: String?

    override func tearDown() async throws {
        if let project { try await LocalAPI.remove(project) }
    }

    func testAPinnedTaskShowsOnTheShelfUntilUnpinned() async throws {
        let word = String(UUID().uuidString.prefix(6)).lowercased()
        let name = "drive pin \(word)"
        let text = "Pack the tent \(word)"
        let project = try await LocalAPI.makeProject(name, tasks: [text])
        self.project = project
        let task = try await LocalAPI.child(of: project, text: text)

        let app = XCUIApplication()
        app.launch()
        app.buttons["Home"].tap()
        let shelfRow = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        let card = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
        try need(card.waitForExistence(timeout: 10),
            "Home doesn't show \"\(name)\". Check that the app reached the local Worker (ios/build/drive.log), then HomeCard in OutlineView.swift.")
        try need(!shelfRow.exists, "\"\(text)\" is on Home before it was pinned. Check shownPins in OutlineView.swift.")
        card.tap()

        let row = app.buttons[text]
        try need(row.waitForExistence(timeout: 5),
            "\"\(name)\" opened without its task \"\(text)\". Check the row's text Button in OutlineView.swift.")
        row.fullSwipe(left: false, in: app)
        try need(zoomed(app, into: task, text),
            "A full right swipe on \"\(text)\" didn't zoom into it. Check onZoom in RowSwipeView.swift.")

        try setPin(app, "Pin")
        let pinned = try await settles(task, pinned: true)
        try need(pinned, "The Worker never saw \"\(text)\" as pinned. Check the setPinned op in scopeMenu, OutlineView.swift.")

        app.buttons["Home"].tap()
        try need(shelfRow.waitForExistence(timeout: 5),
            "Pinned \"\(text)\" isn't on Home's shelf. Check shownPins and PinnedTaskRow in OutlineView.swift.")
        shelfRow.tap()
        try need(zoomed(app, into: task, text),
            "Tapping \"\(text)\" on the shelf didn't open it. Check PinnedTaskRow's onOpen in OutlineView.swift.")

        try setPin(app, "Unpin")
        let unpinned = try await settles(task, pinned: false)
        try need(unpinned, "The Worker still has \"\(text)\" pinned after Unpin. Check the setPinned op in scopeMenu, OutlineView.swift.")
        app.buttons["Home"].tap()
        try need(card.waitForExistence(timeout: 5) && shelfRow.waitForNonExistence(timeout: 5),
            "Unpinned \"\(text)\" is still on Home's shelf. Check shownPins in OutlineView.swift.")

        // Pinned again, a left swipe on the shelf takes it off.
        card.tap()
        try need(row.waitForExistence(timeout: 5), "\"\(name)\" reopened without \"\(text)\".")
        row.fullSwipe(left: false, in: app)
        try setPin(app, "Pin")
        try need(try await settles(task, pinned: true), "Pinning \"\(text)\" a second time never reached the Worker.")
        app.buttons["Home"].tap()
        try need(shelfRow.waitForExistence(timeout: 5), "Pinned again, \"\(text)\" isn't on Home's shelf.")
        shelfRow.fullSwipe(left: true, in: app)
        try need(shelfRow.waitForNonExistence(timeout: 5),
            "A full left swipe on \"\(text)\" left it on Home's shelf. Check the Unpin RowSwipeAction in ProjectGrid, OutlineView.swift.")
        try need(try await settles(task, pinned: false),
            "A left swipe took \"\(text)\" off the shelf but the Worker still has it pinned. Check onUnpin in OutlineView.swift.")
        try need(card.exists, "Unpinning \"\(text)\" by swipe took \"\(name)\" off Home too.")

        print("✓ pinned \"\(text)\" from its ⋯ menu, opened it from Home's shelf, unpinned it, and a left swipe on the shelf unpinned it again")
    }

    /// Whether the screen is zoomed into the task: its text is the title, the
    /// ⋯ menu is up, and it is no longer a row with its own checkbox.
    private func zoomed(_ app: XCUIApplication, into id: String, _ text: String) -> Bool {
        app.buttons["More"].firstMatch.waitForExistence(timeout: 5)
            && app.buttons[text].exists
            && !app.buttons["checkbox \(id)"].exists
    }

    /// Picks Pin or Unpin from the zoomed scope's ⋯ menu.
    private func setPin(_ app: XCUIApplication, _ choice: String) throws {
        let more = app.buttons["More"].firstMatch
        try need(more.waitForExistence(timeout: 5),
            "No ⋯ menu on the zoomed task. It's scopeMenu in OutlineView.swift.")
        more.tap()
        let item = app.buttons[choice]
        try need(item.waitForExistence(timeout: 5),
            "The ⋯ menu has no \(choice). Check the pin Button in scopeMenu, OutlineView.swift.")
        item.tap()
    }

    private func settles(_ id: String, pinned want: Bool) async throws -> Bool {
        for _ in 0..<20 {
            if try await LocalAPI.node(id)?["pinned"] as? Bool == want { return true }
            try await Task.sleep(for: .milliseconds(250))
        }
        return false
    }
}
