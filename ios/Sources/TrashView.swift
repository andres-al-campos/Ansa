import AnsaCore
import AnsaSync
import SwiftUI

/// The trash: what was deleted, with a way to put it back.
///
/// A screen, not a sheet, and not a scope — the trash has no node id — so it is
/// the third thing `slab` can draw. Back lands on the grid.
///
/// Loads when opened and again whenever the tree changes under it: another
/// device may have deleted or restored something, and a stale list offers
/// buttons that fail.
struct TrashView: View {
    let store: OutlineStore

    /// Whether a back swipe has the touch, from its first point. A row's
    /// restore travels the same way, so the row stands down while this is set
    /// — the same exclusion an outline row has.
    let backHolding: Bool
    /// The mirror of `backHolding`: told when a row's swipe takes the touch,
    /// so the back swipe stands down in turn.
    let onSwipingChanged: (Bool) -> Void
    let screenWidth: CGFloat

    /// What Search was asking when its trash line opened this, so the list
    /// shows only what matches it. Nil when opened from Home.
    var query: String? = nil

    /// Nil until the first page lands, which is what tells "still asking" apart
    /// from "nothing deleted" — the same distinction the project grid draws.
    @State private var entries: [TrashEntry]?
    @State private var cursor: Int?
    @State private var busy = false
    @State private var error: String?

    /// The entry a delete swipe is asking about. This delete is the one with
    /// nothing behind it — a full swipe would otherwise destroy a subtree
    /// outright, which is the reason deleting a project asks too.
    @State private var confirming: TrashEntry?

    var body: some View {
        list
        .task { await load() }
        // And again on every tree the server sends, which is what keeps a list
        // open on this screen honest while another device works on it.
        //
        // `store.adopted`, not `store.tree`. A permanent delete elsewhere does
        // not change the tree, so what arrives is an unchanged one sent purely
        // to wake this device — watching `tree` would correctly see no change
        // and leave the row offering a Restore and a Delete that both fail.
        .onChange(of: store.adopted) { Task { await load() } }
        // An alert, as deleting a project asks: centred and modal, with a
        // labelled Cancel. A confirmation dialog pointed at the row like a
        // menu of things to do next.
        .alert(
            confirming.map { "Delete \($0.text.isEmpty ? "Untitled" : $0.text)?" } ?? "",
            isPresented: Binding(
                get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
            presenting: confirming
        ) { entry in
            Button("Cancel", role: .cancel) { confirming = nil }
            Button("Delete", role: .destructive) {
                Task { await forget(entry) }
            }
        } message: { _ in
            Text(deleteWarning)
        }
    }

    /// Says what is lost. A subtree of one is a task; anything more is a branch,
    /// and the count is the only thing that says how much.
    private var deleteWarning: String {
        let subtasks = (confirming?.count ?? 1) - 1
        let size =
            subtasks > 0 ? " and \(subtasks) subtask\(subtasks == 1 ? "" : "s")" : ""
        return "This deletes it\(size) permanently. There is nothing behind the trash."
    }

    /// The entries to draw: every one, or with a query only those whose name
    /// matches it — the same test Search counted them with.
    private var shown: [TrashEntry]? {
        guard let query else { return entries }
        return entries?.filter { !TreeOps.matchRanges($0.text, query).isEmpty }
    }

    @ViewBuilder private var list: some View {
        if let entries = shown {
            if entries.isEmpty {
                ContentUnavailableView(
                    error != nil ? "Could not load the trash"
                        : query.map { "Nothing in the Trash matches “\($0)”" } ?? "Nothing deleted",
                    systemImage: "trash",
                    description: Text(
                        error ?? "Deleted tasks stay here for 30 days."))
            } else {
                List {
                    if let error {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }

                    Section {
                        ForEach(entries) { entry in
                            // An outline row's swipe, so the two lists feel the
                            // same: left deletes, right puts back where zoom
                            // would go in. Not `swipeActions`: its full swipe
                            // and its buttons fought the back swipe and a UI
                            // test's taps, and its threshold isn't the outline's.
                            RowSwipeView(
                                rowId: entry.id,
                                vPadding: OutlineRow.rowPadding / 2,
                                screenWidth: screenWidth,
                                inert: backHolding,
                                // Springs home: the alert asks first, and a
                                // cancel has to find the row where it was.
                                left: RowSwipeAction(
                                    name: "Delete", glyph: .symbol("trash.fill"), tint: .red,
                                    leaves: false,
                                    run: { confirming = entry }),
                                right: RowSwipeAction(
                                    name: "Restore", glyph: .symbol("arrow.up.bin"),
                                    tint: .accentColor, leaves: true,
                                    run: { Task { await restore(entry) } }),
                                onSwipingChanged: onSwipingChanged
                            ) { _ in
                                TrashRow(entry: entry, query: query)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, Space.gutter)
                                    .contentShape(Rectangle())
                            }
                            .padding(.vertical, OutlineRow.rowPadding / 2)
                            .listRowInsets(EdgeInsets())
                            .listRowSeparator(.hidden)
                        }
                    } header: {
                        Text(
                            (query.map { "Matching “\($0)”. " } ?? "")
                                + "Deleted tasks stay here for 30 days, then go on their own.")
                            .textCase(nil)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    if cursor != nil {
                        Button(busy ? "Loading…" : "Load more") {
                            Task { await load(after: cursor) }
                        }
                        .disabled(busy)
                    }
                }
                // Held still during a back swipe or a row's swipe by the page
                // this is drawn in (OutlineView's one `.scrollDisabled`).
                .listStyle(.plain)
            }
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// Appends rather than replacing when paging, so more never loses what is
    /// already on screen.
    private func load(after: Int? = nil) async {
        busy = true
        error = nil
        do {
            var page = try await store.fetchTrash(cursor: after)
            var got = page.entries
            // Filtered, a page can hold no matches while later ones do, so
            // take them all — to the bound Search counted with.
            if query != nil {
                for _ in 1..<20 {
                    guard let next = page.nextCursor else { break }
                    page = try await store.fetchTrash(cursor: next)
                    got += page.entries
                }
            }
            entries = after == nil ? got : (entries ?? []) + got
            cursor = page.nextCursor
        } catch {
            self.error = error.localizedDescription
            // An empty list rather than a spinner forever. The message says
            // what happened; the spinner would only say "still trying".
            if entries == nil { entries = [] }
        }
        busy = false
    }

    private func restore(_ entry: TrashEntry) async {
        await act(entry) { try await store.restoreTrash(entry.id) }
    }

    private func forget(_ entry: TrashEntry) async {
        await act(entry) { try await store.forgetTrash(entry.id) }
    }

    /// The row goes either way. The common failure is an entry that aged out
    /// while the list sat open, so leaving it would offer a button that fails
    /// the same way again.
    private func act(_ entry: TrashEntry, _ body: () async throws -> Void) async {
        error = nil
        do {
            try await body()
        } catch {
            self.error = error.localizedDescription
        }
        entries = (entries ?? []).filter { $0.id != entry.id }
    }
}

/// One deleted subtree: what it was, how big, and how long it has left.
private struct TrashRow: View {
    let entry: TrashEntry
    var query: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(FoundPalette.marked(entry.text.isEmpty ? "Untitled" : entry.text, query ?? ""))
                .lineLimit(1)
            (project + Text(meta).foregroundStyle(.secondary))
                .font(.caption)
        }
    }

    /// The project leads, a step darker than the rest, as on the web: where a
    /// row came from places it faster than anything else on the line. Nothing
    /// for a deleted project, which has no origin to name.
    private var project: Text {
        guard let name = entry.projectText, !name.isEmpty else { return Text("") }
        return Text(name).foregroundStyle(.primary) + Text(" · ").foregroundStyle(.secondary)
    }

    private var meta: String {
        // `count` includes the deleted node itself, so a subtree of one is a
        // plain task and says nothing extra.
        let subtasks = entry.count - 1
        let size = subtasks > 0 ? "\(subtasks) subtask\(subtasks == 1 ? "" : "s") · " : ""
        return size + ago + " · " + left
    }

    /// Coarse on purpose — the exact minute of a deletion is noise.
    private var ago: String {
        switch days {
        case ..<1: return "today"
        case 1: return "yesterday"
        default: return "\(days) days ago"
        }
    }

    /// What is still actionable rather than a precise deadline: the sweep runs
    /// daily past 30 days.
    private var left: String {
        let remaining = 30 - days
        return remaining <= 1 ? "goes today" : "\(remaining) days left"
    }

    private var days: Int {
        Int((Date().timeIntervalSince1970 * 1000 - Double(entry.deletedAt)) / 86_400_000)
    }
}
