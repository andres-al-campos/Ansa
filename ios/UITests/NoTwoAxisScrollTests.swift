import XCTest

/// Law: no screen moves sideways. Every screen here scrolls up and down, so
/// one that also pans sideways scrolls on both axes, and on a phone that
/// always looks broken. Measured on the running app, holding the content most
/// likely to push something wide: a long unbroken word, alone and eight levels
/// deep, under enough rows to scroll.
///
/// On each screen nothing may reach past the screen's sides, and a sideways
/// and a diagonal drag must leave everything at the x it had. Fix a failure at
/// the wide element (wrap or truncate it), not by clipping its parent.
/// laws/no-two-axis-scroll.sh is the source-text half.
@MainActor
final class NoTwoAxisScrollTests: XCTestCase {
    private var project: String?
    private var trashed: String?

    override func tearDown() async throws {
        if let project { try await LocalAPI.remove(project) }
        if let trashed, let entry = try await LocalAPI.trashEntry(holding: trashed) {
            try await LocalAPI.forget(entry)
        }
    }

    func testNoScreenMovesSideways() async throws {
        let word = String(UUID().uuidString.prefix(6)).lowercased()
        let name = "law two-axis \(word)"
        let long = String(repeating: "Supercalifragilisticexpialidocious", count: 4)
        let doomed = "Bin \(word) \(long)"
        var deep = LocalAPI.Seed(text: "Deepest \(long)")
        for level in (1...7).reversed() { deep = LocalAPI.Seed(text: "Level \(level)", children: [deep]) }
        let filler = (1...30).map { LocalAPI.Seed(text: "Task \($0)") }
        let project = try await LocalAPI.makeProject(name,
            children: [LocalAPI.Seed(text: doomed), LocalAPI.Seed(text: long), deep] + filler)
        self.project = project
        let doomedId = try await LocalAPI.child(of: project, text: doomed)
        self.trashed = doomedId

        let app = XCUIApplication()
        app.launch()
        app.buttons["Home"].tap()
        let card = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
        try need(card.waitForExistence(timeout: 10),
            "Home doesn't show \"\(name)\". Check that the app reached the local Worker (ios/build/drive.log), then HomeCard in OutlineView.swift.")
        // Home's cards are plain buttons, and an injected drag that ends on
        // one presses it, so the drag starts in a gap between them.
        let gap = try gapBetweenButtons(app)
        try need(gap != nil, "Home has no gap between its buttons to drag from. Give the drag in NoTwoAxisScrollTests another place to start.")
        try hold(app, on: "Home", dragAt: gap)
        try need(card.exists, "A short drag from a gap on Home left Home. Check what sits at y \(Int(gap! * app.frame.height)) there.")

        card.tap()
        // By prefix: XCUITest aborts the runner on a lookup by a name over
        // 128 characters.
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Bin \(word)")).firstMatch
        try need(row.waitForExistence(timeout: 5),
            "\"\(name)\" opened without its long task. Check the row's text Button in OutlineView.swift.")
        try hold(app, on: "a project", drag: false)

        // Into Trash, so Trash holds a long row too. Before the drags below,
        // which scroll it out of reach.
        row.fullSwipe(left: true, in: app)
        try need(row.waitForNonExistence(timeout: 5),
            "A full left swipe left the long task in place. Check RowSwipeView's gesture.")
        try hold(app, on: "a project")

        app.buttons["Home"].tap()
        let search = app.buttons["Search"]
        try need(search.waitForExistence(timeout: 5),
            "No Search button on Home. It's navCircle(label: \"Search\") in OutlineView.swift.")
        search.tap()
        let field = app.textFields["Search"]
        try need(field.waitForExistence(timeout: 5),
            "Tapping Search opened no field. Check openSearch in OutlineView.swift.")
        field.typeText("Supercali")
        let result = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
        try need(result.waitForExistence(timeout: 5),
            "Search for \"Supercali\" listed nothing from \"\(name)\". Check SearchPage.results in OutlineView.swift.")
        try hold(app, on: "Search", drag: false)
        app.buttons["Close search"].firstMatch.tap()

        let trash = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Trash'")).firstMatch
        try need(trash.waitForExistence(timeout: 5),
            "Home has no Trash row. It's the Button(action: onOpenTrash) in OutlineView.swift.")
        trash.tap()
        let entry = app.cells.containing(NSPredicate(format: "label CONTAINS %@", "Bin \(word)")).firstMatch
        try need(entry.waitForExistence(timeout: 5),
            "Trash doesn't list the long task. Check TrashView.load in TrashView.swift.")
        try hold(app, on: "Trash")

        // Last: the keyboard takes the place of the way out.
        app.buttons["Back"].firstMatch.tap()
        try need(card.waitForExistence(timeout: 5),
            "Back from Trash didn't return to Home. Check the back stack in OutlineView.swift.")
        card.tap()
        let wide = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Supercali'")).firstMatch
        try need(wide.waitForExistence(timeout: 5),
            "\"\(name)\" doesn't show its second long task. Check the row list in OutlineView.swift.")
        wide.tap()
        try need(app.keyboards.firstMatch.waitForExistence(timeout: 5),
            "Tapping the long task didn't open it for editing. Check the row's text Button in OutlineView.swift.")
        try hold(app, on: "a project, editing a row", drag: false)

        print("✓ Home, a project, a row being edited, Search and Trash hold a 136-letter word without moving sideways")
    }

    /// Fails with what on this screen reaches past its sides or moves
    /// sideways under a drag. Per screen, so a wide row is reported as that
    /// and not as the next step it breaks.
    private func hold(_ app: XCUIApplication, on screen: String, drag: Bool = true, dragAt y: CGFloat? = nil) throws {
        let problems = try sideways(app, on: screen, drag: drag, y: y ?? 0.5)
        try need(problems.isEmpty, "A screen moves sideways:\n" + problems.joined(separator: "\n")
            + "\nWrap or truncate the wide element; don't clip its parent.")
    }

    /// The middle of the tallest band in the list that no button covers, as
    /// a fraction of the screen's height, or nil if none is 12pt tall.
    private func gapBetweenButtons(_ app: XCUIApplication) throws -> CGFloat? {
        sleep(1)
        var list = CGRect.zero
        var buttons: [CGRect] = []
        func walk(_ el: XCUIElementSnapshot) {
            if el.elementType == .collectionView, list == .zero { list = el.frame }
            if el.elementType == .button || el.elementType == .textField { buttons.append(el.frame) }
            el.children.forEach(walk)
        }
        walk(try app.snapshot())
        var best: (height: CGFloat, mid: CGFloat)?
        var top = list.minY
        for b in buttons.filter({ $0.maxY > list.minY && $0.minY < list.maxY }).sorted(by: { $0.minY < $1.minY }) + [CGRect(x: 0, y: list.maxY, width: 0, height: 0)] {
            if b.minY - top >= 12, b.minY - top > (best?.height ?? 0) { best = (b.minY - top, (top + b.minY) / 2) }
            top = max(top, b.maxY)
        }
        return best.map { $0.mid / app.frame.height }
    }

    private func sideways(_ app: XCUIApplication, on screen: String, drag: Bool = true, y: CGFloat = 0.5) throws -> [String] {
        sleep(1)
        let width = app.frame.width, height = app.frame.height
        // Every element between the screen's top and bottom, not only text: a
        // scroll view's content is one, and content wider than the screen is
        // what pans. A List keeps rows it has scrolled away, and the keyboard
        // and the scroll bars are the system's.
        func elements() throws -> [(name: String, frame: CGRect)] {
            var found: [(String, CGRect)] = []
            func walk(_ el: XCUIElementSnapshot) {
                if el.elementType == .keyboard || el.elementType == .scrollBar { return }
                let f = el.frame
                if f.width > 0, f.maxY > 0, f.minY < height {
                    let name = el.label.isEmpty ? el.identifier : el.label
                    found.append((name.isEmpty ? "an unlabelled element" : "\"\(name.prefix(30))\"", f))
                }
                el.children.forEach(walk)
            }
            walk(try app.snapshot())
            return found
        }
        let before = try elements()
        var problems = before.filter { $0.frame.minX < -1 || $0.frame.maxX > width + 1 }.prefix(3).map {
            "  \(screen): \($0.name) spans x \(Int($0.frame.minX))…\(Int($0.frame.maxX)) on a \(Int(width))pt screen."
        }
        guard drag else { return Array(problems) }

        // Where each named element sits, to see whether a drag left it there.
        // Read from labels: a row moved by `.offset` keeps its own frame, and
        // only the text inside it shows where it is.
        func xs(_ all: [(name: String, frame: CGRect)]) -> [String: CGFloat] {
            Dictionary(all.filter { $0.name != "an unlabelled element" }.map { ($0.name, $0.frame.minX) },
                uniquingKeysWith: { first, _ in first })
        }
        let was = xs(before)
        // 15% of the screen: short of the quarter that arms a row's swipe
        // (RowSwipe.commitFraction), and clear of the left edge's Back.
        let at = { (x: CGFloat, y: CGFloat) in
            app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y))
        }
        for (kind, to) in [("sideways", at(0.65, y)), ("diagonal", at(0.65, y - 0.1))] {
            at(0.8, y).press(forDuration: 0.05, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.3)
            sleep(1)
            let now = xs(try elements())
            problems += was.filter { name, x in now[name].map { abs($0 - x) > 1 } ?? false }.prefix(3).map {
                "  \(screen): a \(kind) drag moved \($0.key) from x \(Int($0.value)) to \(Int(now[$0.key]!)), and it stayed there."
            }
        }
        return Array(problems)
    }
}
