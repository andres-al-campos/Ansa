import XCTest

/// features/search.md: type part of a task's text, see it under the results
/// with its project beneath, tap it and land in that project.
@MainActor
final class SearchTests: XCTestCase {
    private var project: String?

    override func tearDown() async throws {
        if let project { try await LocalAPI.remove(project) }
    }

    func testFindsATaskAndOpensItsProject() async throws {
        // A word nothing else in the tree has, so the match is this task alone.
        let word = "zq" + String(UUID().uuidString.prefix(6)).lowercased()
        let name = "drive search \(word)"
        let task = "Call the zebra keeper \(word)"
        project = try await LocalAPI.makeProject(name, tasks: [task])

        let app = XCUIApplication()
        app.launch()

        // From Home, so the results are one list rather than this project's
        // first. The app reopens wherever it last was.
        app.buttons["Home"].tap()

        let search = app.buttons["Search"]
        try need(search.waitForExistence(timeout: 10),
            "No Search button on launch. It's navCircle(label: \"Search\") in OutlineView.swift; check it still has that label.")
        search.tap()

        let field = app.textFields["Search"]
        try need(field.waitForExistence(timeout: 5),
            "Tapping Search opened no field. Check openSearch and searchField in OutlineView.swift.")
        field.typeText(word)

        // The row reads as the task, then the project it is in.
        let result = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", task)).firstMatch
        try need(result.waitForExistence(timeout: 5),
            "\"\(word)\" didn't list \"\(task)\". Check TreeOps.search in AnsaCore and SearchPage.results in OutlineView.swift.")
        try need(result.label.contains(name),
            "The result's label is \"\(result.label)\", without its project \"\(name)\" beneath. Check SearchPage.trail(of:).")
        result.tap()

        try need(field.waitForNonExistence(timeout: 5),
            "Tapping the result left Search open. Check openFromSearch in OutlineView.swift.")
        try need(app.staticTexts[name].waitForExistence(timeout: 5),
            "Tapping the result didn't open \"\(name)\". Check openFromSearch in OutlineView.swift.")
        print("✓ \"\(word)\" found \"\(task)\" under \(name) and opened it")
    }
}
