import AnsaCore
import Foundation

/// The last tree seen, kept on disk so a cold launch has something to draw
/// before the network answers.
///
/// The problem it solves is a blank screen: the tree starts empty and the first
/// paint waits on a round trip to the server, so opening the app showed no
/// projects for as long as that took. On a slow connection that reads as an
/// empty account rather than a pending one.
///
/// Unlike `OpQueue` this holds nothing the server does not already have. Losing
/// it, failing to write it, or finding it corrupt all cost exactly one blank
/// first paint — which is the behaviour without it — so every failure here is
/// swallowed rather than surfaced.
///
/// **It is a paint, not a source of truth.** Nothing derived from it is ever
/// sent: `SyncClient` adopts the server's tree wholesale when it arrives, and
/// unsent work lives in the queue, not here. Replaying the queue on top of a
/// cached tree is deliberately *not* done — a stale `setDone` can complete a
/// parent whose other children were finished elsewhere, and an index-based
/// `moveNode` means a different position once someone else has reordered the
/// list. Those are real conflicts and want a real answer, not a silent merge.
@MainActor
public final class TreeCache {
    private let url: URL

    public init(url: URL) {
        self.url = url
    }

    /// The stored tree, or nil for a cold start, an unreadable file, or one
    /// written by a version whose shape no longer decodes.
    public func load() -> Tree? {
        guard let data = try? Data(contentsOf: url),
              let tree = try? JSONDecoder().decode(Tree.self, from: data),
              !tree.isEmpty
        else { return nil }
        return tree
    }

    /// Mirror to disk, atomically so a kill mid-write leaves the previous tree
    /// rather than a truncated one.
    ///
    /// An empty tree removes the file instead of storing `[]`. Storing it would
    /// be indistinguishable on the next launch from having no cache at all, and
    /// the file would then claim the user has no projects — a claim only the
    /// server is allowed to make.
    public func save(_ tree: Tree) {
        do {
            if tree.isEmpty {
                try? FileManager.default.removeItem(at: url)
                return
            }
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(tree).write(to: url, options: .atomic)
        } catch {
            print("Ansa: could not cache the tree — \(error)")
        }
    }
}
