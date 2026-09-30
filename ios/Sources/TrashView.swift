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

    /// Whether a back swipe is currently carrying this screen aside.
    ///
    /// Only to lock the scroll while it is — see the `List` below. The swipe
    /// itself belongs to the view that draws this one, which is also where the
    /// pull it reads is measured.
    let backing: Bool

    /// What Search was asking when its trash line opened this, so the list
    /// shows only what matches it. Nil when opened from Home.
    var query: String? = nil

    /// Nil until the first page lands, which is what tells "still asking" apart
    /// from "nothing deleted" — the same distinction the project grid draws.
    @State private var entries: [TrashEntry]?
    @State private var cursor: Int?
    @State private var busy = false
    @State private var error: String?

    /// The entry a "Delete" swipe is asking about. This delete is the one with
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
        .confirmationDialog(
            confirming.map { $0.text.isEmpty ? "Untitled" : $0.text } ?? "",
            isPresented: Binding(
                get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete for good", role: .destructive) {
                if let entry = confirming {
                    Task { await forget(entry) }
                }
            }
        } message: {
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
                            TrashRow(entry: entry, query: query)
                                // Words, no glyphs. A swipe button given a
                                // title *and* an image shows only the image when
                                // the row is too short for both, so "Restore"
                                // appeared as a bare undo arrow — which means
                                // "undo the last thing", not "put this back".
                                //
                                // Both on the trailing edge. On the leading
                                // edge, Restore's full swipe was the same
                                // motion as the back swipe, so going back from
                                // over a row also restored it.
                                .swipeActions(edge: .trailing) {
                                    // First, so a full swipe restores.
                                    Button("Restore") {
                                        Task { await restore(entry) }
                                    }
                                    .tint(.blue)
                                    // No `role: .destructive`: that styles the
                                    // button red *and* makes a full swipe fire
                                    // it. `tint` keeps the red without the
                                    // gesture that skips the question.
                                    Button("Delete") {
                                        confirming = entry
                                    }
                                    .tint(.red)
                                }
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
                // While the back swipe carries this screen aside, so one finger
                // cannot scroll and slide at once. The list's own recogniser is
                // not something the swipe can outrank, so the lock has to be
                // this.
                .scrollDisabled(backing)
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
