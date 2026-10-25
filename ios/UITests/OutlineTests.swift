import XCTest

/// dev/features/outline.md: make a project from Home's +, name it, and Return flows
/// into its first task; Return asks for another row, Indent nests it. The
/// shape is read back from the Worker.
@MainActor
final class OutlineTests: XCTestCase {
    private var projectName: String?

    override func tearDown() async throws {
        if let projectName, let project = try? await LocalAPI.child(of: nil, text: projectName) {
            try await LocalAPI.remove(project)
        }
    }

    func testANewProjectTakesNestedTasksByKeyboard() async throws {
        let name = "drive outline " + String(UUID().uuidString.prefix(6)).lowercased()
        projectName = name

        let app = XCUIApplication()
        app.launch()
        app.buttons["Home"].tap()
        let plus = app.descendants(matching: .any)["New project"].firstMatch
        try need(plus.waitForExistence(timeout: 10),
            "Home has no New project button. It's the + labelled \"New project\" in OutlineView.swift.")
        plus.tap()

        // Each line goes into whatever row the app has focused; a missing
        // keyboard is the failure.
        func type(_ text: String) throws {
            try need(app.keyboards.firstMatch.waitForExistence(timeout: 5),
                "No keyboard up to type \"\(text)\". Check that the new row takes focus in EditController.swift.")
            app.typeText(text)
        }
        try type(name + "\n")
        try type("Parent\n")
        try type("Child A")
        let indent = app.buttons["Indent"]
        try need(indent.waitForExistence(timeout: 5) && indent.isEnabled,
            "No Indent on the keyboard strip under \"Child A\". Check depthButtons in OutlineView.swift.")
        indent.tap()
        try type("\nChild B")
        let done = app.buttons["Done"].firstMatch
        try need(done.waitForExistence(timeout: 5),
            "No Done on the keyboard strip. Check doneButton in OutlineView.swift.")
        done.tap()

        var shape: String?
        for _ in 0..<20 where shape == nil {
            if let project = try? await LocalAPI.child(of: nil, text: name),
               let parent = try? await LocalAPI.child(of: project, text: "Parent"),
               (try? await LocalAPI.child(of: parent, text: "Child A")) != nil,
               (try? await LocalAPI.child(of: parent, text: "Child B")) != nil {
                shape = "\(name) › Parent › Child A, Child B"
            } else {
                try await Task.sleep(for: .milliseconds(250))
            }
        }
        try need(shape != nil,
            "The Worker doesn't have \(name) › Parent › Child A, Child B. Check indentRow and the adding flow in OutlineView.swift, then the op queue in OutlineStore.swift.")

        print("✓ made \(shape!) from Home's + by keyboard")
    }
}
