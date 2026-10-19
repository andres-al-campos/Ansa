import AnsaCore
import AnsaSync
import Foundation
import Observation

/// The app's tree, and the one place an edit is allowed to happen.
///
/// Local-first: `apply` runs the same pure op the server will, hands the result
/// to the view immediately, then queues it for sending. The screen never waits
/// on the network, and both sides compute the same thing.
@MainActor
@Observable
final class OutlineStore {
    private(set) var tree: Tree = [] {
        didSet { cache.save(tree) }
    }
    /// Whether the first server tree has landed. The grid tells "still asking"
    /// apart from "you have no projects" with this — before, both were an empty
    /// list and a new user saw the same screen as a slow connection.
    private(set) var loaded = false
    /// Bumped every time a server tree is adopted, differing or not.
    ///
    /// The trash needs this and `tree` cannot give it: permanently deleting a
    /// trash entry does not change the tree, so the server broadcasts an
    /// unchanged one and `onChange(of: tree)` correctly skips it, leaving the
    /// trash stale.
    ///
    /// A counter, not a flag — two broadcasts in a row are two distinct values,
    /// where a Bool set twice to true is one.
    private(set) var adopted = 0
    /// False once the live connection has failed repeatedly — the app has
    /// stopped *receiving*. Writes are unaffected, so the UI should say changes
    /// are still saved.
    private(set) var live = true
    private(set) var rejected = 0
    /// The server's explanation for the latest refusal, when a person can act
    /// on it — being at the node cap, today. Nil for the ordinary races.
    private(set) var rejectedReason: String?

    @ObservationIgnored private var sync: SyncClient?
    @ObservationIgnored private let api: AnsaAPI
    @ObservationIgnored private let cache: TreeCache

    init(token: @escaping TokenSource = ClerkToken.current) {
        api = AnsaAPI(
            base: Config.apiBase, token: token, user: Config.devUser,
            // A signing build has no use for the `user` fallback — the server
            // refuses it — so a missing token means wait, not fail.
            authenticated: ClerkConfig.publishableKey != nil)
        cache = TreeCache(url: Self.cacheURL)
        // Straight into the stored property, so the read happens before the
        // first paint rather than a frame into it. Assigning `tree` here would
        // also bounce it back to disk through `didSet` for no reason.
        if let cached = cache.load() { _tree = cached }
    }

    func start() {
        guard sync == nil else { return }
        let client = SyncClient(
            api: api, queueURL: Self.queueURL,
            current: { [weak self] in self?.tree ?? [] },
            // Someone else's edit, applied straight in. Not sent back: it is
            // the server's already. Counted as an adopt because the trash
            // watches that counter and a remote delete lands here.
            onApply: { [weak self] op in
                guard let self else { return }
                self.tree = TreeOps.applyOp(self.tree, op).tree
                self.adopted += 1
            }
        ) { [weak self] tree in
            self?.tree = tree
            self?.adopted += 1
        }
        // Reads `client`, not `self.sync`: same object, but `self.sync` is
        // assigned on the line below, so a guard on it would drop any status
        // change arriving before then.
        //
        // `unowned` because this closure is stored *on* `client`, so a strong
        // capture is a cycle through itself that `stop()` does not break.
        client.onStatusChange = { [weak self, unowned client] in
            guard let self else { return }
            self.live = client.live
            self.rejected = client.rejected
            self.rejectedReason = client.rejectedReason
        }
        sync = client
        client.start()

        Task {
            // The socket's first broadcast only arrives when something
            // *changes*, so without this fetch, opening the app to an unchanged
            // tree would show nothing until someone edited it.
            if let served = await api.loadTree() { adoptInitial(served) }
            // Set either way: a failed fetch has still finished asking, and
            // leaving this false holds a spinner up forever on an offline
            // device that has a perfectly good cached tree.
            loaded = true
            await api.seedIfEmpty()
        }
    }

    /// Dismiss the refusal banner. The edit is already gone either way; this
    /// only stops the message being permanent furniture.
    func clearRejected() {
        sync?.clearRejected()
        rejected = 0
        rejectedReason = nil
    }

    /// Every edit goes through here, so there is one path from a gesture to
    /// both the screen and the server.
    ///
    /// Hands back the ids of any parents that flipped to done — discarded by
    /// most callers, but how the ripple knows a branch finished rather than a
    /// single task being ticked.
    @discardableResult
    func apply(_ op: Op) -> [NodeId] {
        let result = TreeOps.applyOp(tree, op)
        tree = result.tree
        sync?.send(op)
        return result.completed
    }

    /// True while the user is editing — an incoming tree is stashed rather than
    /// swapped in under them.
    func setBusy(_ busy: Bool) {
        sync?.setBusy(busy)
    }

    /// The app went into the background. Ops already queued are on disk, so
    /// there is nothing to flush here — only a socket to let go of.
    func suspend() {
        sync?.suspend()
    }

    /// The app came back. Reconnects and refetches, because everything that
    /// happened on other devices while this one was suspended arrived as socket
    /// broadcasts nobody was listening for.
    ///
    /// Falls through to `start()` on the path where the app was launched
    /// straight into the background and so never built a client.
    func resume() {
        guard let sync else {
            start()
            return
        }
        sync.resume()
    }

    /// The initial fetch. Routed through the client rather than assigned
    /// directly so it counts as the first adopt, which is what releases any ops
    /// restored from a previous run.
    private func adoptInitial(_ served: Tree) {
        sync?.adoptInitial(served)
    }

    // ------------------------------------------------------------ the trash

    /// A page of deleted subtrees. Forwarded rather than exposing `api`, so
    /// every path from a screen to the server still runs through this one type.
    func fetchTrash(cursor: Int? = nil) async throws -> TrashPage {
        try await api.fetchTrash(cursor: cursor)
    }

    /// Put a deleted subtree back, and take the tree the server returns.
    ///
    /// Assigned rather than applied as an op: a restore has no op — the server
    /// decides where the subtree lands, which is why the whole tree comes back.
    func restoreTrash(_ entryId: String) async throws {
        tree = try await api.restoreTrash(entryId)
    }

    /// Delete one entry for good, now. The tree is unchanged either way — a
    /// trashed subtree was never in it.
    func forgetTrash(_ entryId: String) async throws {
        try await api.forgetTrash(entryId)
    }

    /// Beside the queue, in Application Support: this is recoverable state the
    /// user did not create, so it does not belong in Documents, and it must not
    /// be in Caches, which the OS may delete under pressure — losing exactly
    /// the unsent edits it exists to protect.
    private static var queueURL: URL {
        let dir = URL.applicationSupportDirectory.appending(path: "Ansa")
        return dir.appending(path: "queue.v1.json")
    }

    /// Beside the queue, and for the same reason — but unlike the queue this
    /// holds nothing the server does not already have, so losing it costs a
    /// blank first paint and nothing else.
    private static var cacheURL: URL {
        let dir = URL.applicationSupportDirectory.appending(path: "Ansa")
        return dir.appending(path: "tree.v1.json")
    }
}
