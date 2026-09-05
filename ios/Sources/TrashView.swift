import AnsaSync
import SwiftUI

/// The trash: what was deleted, with a way to put it back.
///
/// A sheet rather than a change of `scope`. Zooming is movement inside the
/// tree and the back swipe is how you undo it; the trash is not in the tree at
/// all, so giving it a scope would put a place in the breadcrumb that has no
/// parent to go back to.
///
/// Loads when opened, and again on every open. Another device may have deleted
/// or restored something since, and a stale list offers buttons that fail.
struct TrashView: View {
    let store: OutlineStore
    @Environment(\.dismiss) private var dismiss

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
        NavigationStack {
            list
                .navigationTitle("Trash")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
        .task { await load() }
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

    @ViewBuilder private var list: some View {
        if let entries {
            if entries.isEmpty {
                ContentUnavailableView(
                    error == nil ? "Nothing deleted" : "Could not load the trash",
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
                            TrashRow(entry: entry)
                                // Swipes rather than buttons in the row. Both
                                // actions are destructive-shaped — one undoes a
                                // delete, the other finishes it — and a row with
                                // two buttons on it invites the wrong one.
                                .swipeActions(edge: .leading) {
                                    Button("Restore", systemImage: "arrow.uturn.backward") {
                                        Task { await restore(entry) }
                                    }
                                    .tint(.blue)
                                }
                                .swipeActions(edge: .trailing) {
                                    // No `role: .destructive`: that styles the
                                    // button red *and* makes a full swipe fire
                                    // it. `tint` keeps the red without the
                                    // gesture that skips the question.
                                    Button("Delete", systemImage: "trash") {
                                        confirming = entry
                                    }
                                    .tint(.red)
                                }
                        }
                    } header: {
                        Text("Deleted tasks stay here for 30 days, then go on their own.")
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
            let page = try await store.fetchTrash(cursor: after)
            entries = after == nil ? page.entries : (entries ?? []) + page.entries
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

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(entry.text.isEmpty ? "Untitled" : entry.text)
                .lineLimit(1)
            Text(meta)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
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
