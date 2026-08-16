import AnsaCore
import Foundation

/// The unsent ops, oldest first, mirrored to disk after every change.
///
/// The web client keeps this in localStorage (see `src/storage.ts`); on a phone
/// it matters more, because the OS kills backgrounded apps as a matter of
/// course rather than only when something goes wrong. Without persistence the
/// local tree survives and the ops that would tell the server about it don't,
/// so the server's tree silently overwrites that work at the next adopt.
///
/// A file rather than UserDefaults: this can reach a few hundred KB after a
/// long offline stretch, and UserDefaults is a plist loaded whole on first
/// access. Writes are atomic, so a kill mid-write leaves the previous queue
/// rather than a truncated one.
///
/// Not an actor. `SyncClient` is the only owner and is already `@MainActor`;
/// making this independently concurrent would mean the queue could change
/// between `head` and `removeHead`, which is exactly the interleaving the
/// strict-ordering rule exists to prevent.
@MainActor
final class OpQueue {
    private var ops: [Op]
    private let url: URL

    /// - Parameter url: where to mirror the queue. Missing or unreadable is a
    ///   normal cold start, not an error.
    init(url: URL) {
        self.url = url
        self.ops = Self.load(from: url)
    }

    var isEmpty: Bool { ops.isEmpty }
    var count: Int { ops.count }
    var head: Op? { ops.first }

    func append(_ incoming: [Op]) {
        guard !incoming.isEmpty else { return }
        ops.append(contentsOf: incoming)
        persist()
    }

    /// Drop the op that has now been dealt with — either stored or refused.
    ///
    /// Persisted here rather than once at the end of a drain, because the app
    /// can be killed mid-drain and the file has to match what actually went
    /// out. Re-sending an op the server already applied is not free: `addChild`
    /// carries its own id, so a replay is idempotent, but `toggleCollapsed` is
    /// not and would flip back.
    func removeHead() {
        guard !ops.isEmpty else { return }
        ops.removeFirst()
        persist()
    }

    /// Mirror to disk. Failures are swallowed: a queue that cannot be saved is
    /// still a queue that can be sent, and throwing here would break the edit
    /// that triggered it.
    private func persist() {
        do {
            if ops.isEmpty {
                try? FileManager.default.removeItem(at: url)
                return
            }
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(ops).write(to: url, options: .atomic)
        } catch {
            // Deliberately not fatal — see above. Logged because a disk that
            // silently stopped accepting writes is worth being able to find.
            print("Ansa: could not persist the op queue — \(error)")
        }
    }

    /// Read the queue back, discarding anything unreadable.
    ///
    /// Shallow by design, like the web client's `loadQueue`. A decoded op is
    /// merely plausible, not trusted: the server validates every op it
    /// receives and a rejected one is discarded rather than retried. The only
    /// job here is to stop a corrupt file from breaking the boot — which, on a
    /// phone, would mean an app that cannot start until it is reinstalled.
    private static func load(from url: URL) -> [Op] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        do {
            return try JSONDecoder().decode([Op].self, from: data)
        } catch {
            print("Ansa: discarding an unreadable op queue — \(error)")
            return []
        }
    }
}
