import XCTest

/// dev/features/check-off.md: a project is done exactly when all its tasks are.
/// Ticking one of two leaves it open, ticking both completes it, unticking one
/// reopens it. Each step is read twice: on the box, and on the Worker, so a
/// tick that draws but never syncs fails too.
@MainActor
final class CheckOffTests: XCTestCase {
    private var project: String?

    override func tearDown() async throws {
        if let project { try await LocalAPI.remove(project) }
    }

    func testAProjectIsDoneWhenAllItsTasksAre() async throws {
        let name = "drive check-off " + String(UUID().uuidString.prefix(6)).lowercased()
        let project = try await LocalAPI.makeProject(name, tasks: ["Tent", "Stove"])
        self.project = project
        let tent = try await LocalAPI.child(of: project, text: "Tent")
        let stove = try await LocalAPI.child(of: project, text: "Stove")

        let app = XCUIApplication()
        app.launch()
        app.buttons["Home"].tap()
        let card = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
        try need(card.waitForExistence(timeout: 10),
            "Home doesn't show \"\(name)\". Check that the app reached the local Worker (ios/build/drive.log), then HomeCard in OutlineView.swift.")
        card.tap()

        func tick(_ id: String, _ text: String, done: Bool) async throws {
            let box = app.buttons["checkbox \(id)"]
            try need(box.waitForExistence(timeout: 5),
                "No checkbox for \"\(text)\". It's the Button around Checkbox in OutlineView.swift; check it keeps .accessibilityIdentifier(\"checkbox <id>\").")
            box.tap()
            try need(box.isSelected == done,
                "\"\(text)\"'s box reads \(box.isSelected ? "ticked" : "unticked") after the tap. Check toggleDone in OutlineView.swift.")
            let synced = try await LocalAPI.settles(id, done: done)
            try need(synced,
                "The Worker never saw \"\(text)\" as \(done ? "done" : "not done"). Check toggleDone and the op queue in OutlineStore.swift.")
        }

        try await tick(tent, "Tent", done: true)
        let openAfterOne = try await LocalAPI.settles(project, done: false)
        try need(openAfterOne,
            "Ticking one of two tasks finished the project. Check TreeOps.reconcileDone in ios/AnsaCore/Sources/AnsaCore/Tree.swift and setDone in shared/ops.ts.")

        try await tick(stove, "Stove", done: true)
        let doneAfterBoth = try await LocalAPI.settles(project, done: true)
        try need(doneAfterBoth,
            "Ticking both tasks left the project open. Check TreeOps.reconcileDone in ios/AnsaCore/Sources/AnsaCore/Tree.swift and setDone in shared/ops.ts.")

        try await tick(tent, "Tent", done: false)
        let reopened = try await LocalAPI.settles(project, done: false)
        try need(reopened,
            "Unticking a task left the project done. Check TreeOps.reconcileDone in ios/AnsaCore/Sources/AnsaCore/Tree.swift and setDone in shared/ops.ts.")

        print("✓ one of two ticked leaves \(name) open, both finish it, unticking one reopens it")
    }
}
