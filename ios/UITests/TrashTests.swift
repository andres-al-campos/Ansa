import XCTest

/// features/trash.md: swipe a task left and it goes to Trash; restore it from
/// Trash and it is back under its project. Read on screen and on the Worker.
@MainActor
final class TrashTests: XCTestCase {
    private var project: String?
    private var task: String?

    override func tearDown() async throws {
        // The project first, so a failed Trash lookup can't strand it.
        if let project { try await LocalAPI.remove(project) }
        // A run that stops between the delete and the restore leaves the task
        // in Trash, out of reach of the project's own removal.
        if let task, let entry = try await LocalAPI.trashEntry(holding: task) {
            try await LocalAPI.forget(entry)
        }
    }

    func testASwipedTaskGoesToTrashAndComesBack() async throws {
        let word = String(UUID().uuidString.prefix(6)).lowercased()
        let name = "drive trash \(word)"
        let text = "Throw out \(word)"
        let project = try await LocalAPI.makeProject(name, tasks: ["Keep", text])
        self.project = project
        let task = try await LocalAPI.child(of: project, text: text)
        self.task = task

        let app = XCUIApplication()
        app.launch()
        app.buttons["Home"].tap()
        let card = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
        try need(card.waitForExistence(timeout: 10),
            "Home doesn't show \"\(name)\". Check that the app reached the local Worker (ios/build/drive.log), then HomeCard in OutlineView.swift.")
        card.tap()

        let row = app.buttons[text]
        try need(row.waitForExistence(timeout: 5),
            "\"\(name)\" opened without its task \"\(text)\". Check the row's text Button in OutlineView.swift.")
        row.fullSwipe(left: true, in: app)

        try need(row.waitForNonExistence(timeout: 5),
            "A full left swipe left \"\(text)\" in place. Check RowSwipeView's gesture and RowSwipe.isArmed in AnsaCore.")
        var gone = false
        for _ in 0..<20 where !gone {
            gone = try await LocalAPI.node(task) == nil
            if !gone { try await Task.sleep(for: .milliseconds(250)) }
        }
        try need(gone, "\"\(text)\" left the screen but the Worker still has it. Check onDelete in OutlineView.swift and the op queue in OutlineStore.swift.")
        let trashed = try await LocalAPI.trashEntry(holding: task)
        try need(trashed != nil, "The Worker deleted \"\(text)\" without a Trash entry. Check the remove op in worker/src/treeStore.ts.")

        app.buttons["Home"].tap()
        let trash = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Trash'")).firstMatch
        try need(trash.waitForExistence(timeout: 5),
            "Home has no Trash row. It's the Button(action: onOpenTrash) in OutlineView.swift.")
        trash.tap()

        let entry = app.cells.containing(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        try need(entry.waitForExistence(timeout: 5),
            "Trash doesn't list \"\(text)\". Check TrashView.load in TrashView.swift.")
        // A full swipe fires the first action, Restore. Tapping the revealed
        // button doesn't reach a SwiftUI swipe action from a UI test: the
        // row stays open and the action never runs.
        entry.fullSwipe(left: true, in: app)

        try need(entry.waitForNonExistence(timeout: 5),
            "Restore left \"\(text)\" in Trash. Check restore(_:) in TrashView.swift.")
        let back = try await LocalAPI.node(task)
        try need(back?["parentId"] as? String == project,
            "After Restore the Worker has \"\(text)\" \(back == nil ? "nowhere" : "under \(back?["parentId"] ?? "nothing")"), not under \(name). Check restoreTrash in OutlineStore.swift, then restore in worker/src/treeStore.ts.")

        print("✓ a full swipe sent \"\(text)\" to Trash, and Restore put it back under \(name)")
    }
}
