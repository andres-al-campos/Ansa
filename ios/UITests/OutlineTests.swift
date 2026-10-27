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

    /// Why the simulator runs the on-screen keyboard: with a hardware one
    /// nothing covers the bottom of the screen, so a strip that doesn't ride
    /// the keyboard, or a run that doesn't scroll the typed row clear of it,
    /// looks right here and is broken on a phone.
    func testTheTypedRowAndTheStripStayAboveTheKeyboard() async throws {
        let name = "drive keyboard " + String(UUID().uuidString.prefix(6)).lowercased()
        projectName = name

        let app = XCUIApplication()
        app.launch()
        app.buttons["Home"].tap()
        app.descendants(matching: .any)["New project"].firstMatch.tap()
        let keyboard = app.keyboards.firstMatch
        try need(keyboard.waitForExistence(timeout: 5),
            "No keyboard up to name the project. Untick Device Hub's Device → Keyboard → Simulate Hardware Keyboard; this drive is about the on-screen one.")
        app.typeText(name + "\n")
        // More rows than fit above the keyboard, so the last only stays in
        // view if the run scrolls.
        for i in 1...14 { app.typeText("Row \(i)\n") }

        // The keyboard reports where it is mid-slide; wait for it to stop.
        var top = keyboard.frame.minY
        for _ in 0..<20 {
            try await Task.sleep(for: .milliseconds(150))
            let now = keyboard.frame.minY
            if now == top && now < app.frame.height { break }
            top = now
        }
        try need(top < app.frame.height,
            "The keyboard never settled on screen (its top read \(Int(top)) on a \(Int(app.frame.height))pt screen). Untick Device Hub's Device → Keyboard → Simulate Hardware Keyboard.")

        let strip = app.buttons["Indent"].frame
        // The gap allows for the suggestions bar, which sits above the keys
        // but outside the keyboard's frame.
        try need(strip.maxY <= top && top - strip.maxY < 80,
            "The Indent strip ends at y \(Int(strip.maxY)) with the keyboard's top at \(Int(top)): it should ride just above it. Check the bottom safeAreaInset in OutlineView.swift.")
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "hasKeyboardFocus == 1")).firstMatch.frame
        try need(row.height > 0 && row.minY >= 0 && row.maxY <= strip.minY,
            "The row being typed spans y \(Int(row.minY))…\(Int(row.maxY)), not clear above the strip at \(Int(strip.minY)). Check that the strip is the list's bottom safeAreaInset in OutlineView.swift (an overlay lets rows run under it), then scrollInto.")

        print("✓ after 14 rows, the typed row (y \(Int(row.maxY))) stays above the strip (\(Int(strip.minY))…\(Int(strip.maxY))), which rides the keyboard (\(Int(top)))")
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
                "No keyboard up to type \"\(text)\". Check that the new row takes focus in EditController.swift, or, if the row is focused, untick Device Hub's Device → Keyboard → Simulate Hardware Keyboard.")
            app.typeText(text)
        }
        try type(name + "\n")
        try type("Parent\n")
        try type("Child A")
        let indent = app.buttons["Indent"]
        try need(indent.waitForExistence(timeout: 5) && indent.isEnabled,
            "No Indent on the keyboard strip under \"Child A\". Check depthButtons in OutlineView.swift.")
        indent.tap()
        // Return and the next line in separate calls, as above: XCUITest waits
        // for the app to go idle between them, as a person waits for the new
        // row. In one call the on-screen keyboard outruns the focus hand-off
        // after Return, and "Ch" lands in Child A.
        try type("\n")
        try type("Child B")
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
        let built = shape == nil ? ((try? await LocalAPI.outline(ofProject: name)) ?? "unreadable") : ""
        try need(shape != nil,
            "The Worker doesn't have \(name) › Parent › Child A, Child B; it has:\n\(built)\nCheck indentRow and the adding flow in OutlineView.swift, then the op queue in OutlineStore.swift.")

        print("✓ made \(shape!) from Home's + by keyboard")
    }
}
