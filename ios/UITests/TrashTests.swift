import XCTest

/// features/trash.md: swipe a task left and it goes to Trash. In Trash, the
/// same swipe: left asks before deleting for good, right restores, and right
/// from the screen's edge is still Back. Read on screen and on the Worker.
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

        // Left asks before deleting for good; Cancel leaves it be.
        entry.fullSwipe(left: true, in: app)
        // An alert, not a dialog pointing at the row: centred, with a Cancel.
        let ask = app.alerts.firstMatch
        try need(ask.waitForExistence(timeout: 5) && ask.buttons["Delete"].exists,
            "A full left swipe on \"\(text)\" in Trash didn't ask in an alert before deleting for good. Check the left RowSwipeAction and the alert in TrashView.swift.")
        ask.buttons["Cancel"].tap()
        // The label, not the cell: a row parked off screen keeps its cell's
        // frame, and only the content inside it moves.
        try need(ask.waitForNonExistence(timeout: 5),
            "Cancel didn't close the delete alert. Check the alert in TrashView.swift.")
        sleep(1)
        let label = entry.staticTexts[text].frame
        try need(label.minX >= 0 && label.maxX <= app.frame.maxX,
            "After Cancel, \"\(text)\" sits off screen at x=\(Int(label.minX)) rather than back in place. The left RowSwipeAction in TrashView.swift must not ride out (leaves: false).")
        let stillThere = try await LocalAPI.trashEntry(holding: task)
        try need(stillThere != nil, "Cancelling the delete still emptied \"\(text)\" from Trash. Check the alert in TrashView.swift.")

        // Right from the screen's edge is Back, not Restore.
        let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
            .withOffset(CGVector(dx: 8, dy: entry.frame.midY))
        let across = app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0))
            .withOffset(CGVector(dx: 0, dy: entry.frame.midY))
        edge.press(forDuration: 0.05, thenDragTo: across, withVelocity: .default, thenHoldForDuration: 0.1)
        // Trash's own header gone, not Home's Trash row present: a copy of
        // Home is drawn behind a back swipe in progress, so its row exists
        // whether or not Back finished.
        let header = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Deleted tasks stay here'")).firstMatch
        try need(header.waitForNonExistence(timeout: 5) && trash.isHittable,
            "A right swipe from the screen's edge over \"\(text)\" didn't go back to Home. Check backHolding and zoomOutSwipe in OutlineView.swift.")
        let notRestored = try await LocalAPI.trashEntry(holding: task)
        try need(notRestored != nil,
            "Going back by the edge over \"\(text)\" also restored it. The row has to stand down while backHolding is set; check TrashView's inert.")
        trash.tap()
        try need(entry.waitForExistence(timeout: 5), "Reopening Trash lost \"\(text)\". Check TrashView.load in TrashView.swift.")

        // Right restores.
        entry.fullSwipe(left: false, in: app)
        try need(entry.waitForNonExistence(timeout: 5),
            "A full right swipe left \"\(text)\" in Trash. Check the right RowSwipeAction and restore(_:) in TrashView.swift.")
        let back = try await LocalAPI.node(task)
        try need(back?["parentId"] as? String == project,
            "After Restore the Worker has \"\(text)\" \(back == nil ? "nowhere" : "under \(back?["parentId"] ?? "nothing")"), not under \(name). Check restoreTrash in OutlineStore.swift, then restore in worker/src/treeStore.ts.")

        print("✓ a left swipe sent \"\(text)\" to Trash; there, left asked first, the edge went Back, and right put it back under \(name)")
    }
}
