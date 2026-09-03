import AnsaCore
import AnsaSync
import Foundation
import Observation

/// The app's tree, and the one place an edit is allowed to happen.
///
/// Local-first: `apply` computes the new tree with the same pure op the server
/// will run, hands it to the view immediately, and only then queues it for
/// sending. The screen never waits on the network, and because both sides run
/// the identical op, what the user sees is already what the server will
/// compute.
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
    /// False once the live connection has failed repeatedly — the app has
    /// stopped *receiving*. Writes are unaffected, so the UI should say changes
    /// are still saved.
    private(set) var live = true
    private(set) var rejected = 0

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
        let client = SyncClient(api: api, queueURL: Self.queueURL) { [weak self] tree in
            self?.tree = tree
        }
        client.onStatusChange = { [weak self] in
            guard let self, let sync = self.sync else { return }
            self.live = sync.live
            self.rejected = sync.rejected
        }
        sync = client
        client.start()

        Task {
            // A first paint from the server before the socket has said
            // anything. The socket is the steady-state channel, but its first
            // broadcast only arrives when something *changes* — without this
            // fetch, opening the app to an unchanged tree would show nothing
            // until someone edited it.
            if let served = await api.loadTree() { adoptInitial(served) }
            // Set either way: a fetch that failed has still finished asking, and
            // leaving this false would hold a spinner up forever on a device
            // that is simply offline. The cached tree is what it shows then.
            loaded = true
            await api.seedIfEmpty()
        }
    }

    /// Every edit goes through here, so there is exactly one path from a
    /// gesture to both the screen and the server.
    ///
    /// Hands back the ids of any parents that flipped to done.
    ///
    /// Discarded by most callers. The completion ripple is the one that wants
    /// them: they are how it knows a branch actually finished, as opposed to a
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
