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
    private(set) var tree: Tree = []
    /// False once the live connection has failed repeatedly — the app has
    /// stopped *receiving*. Writes are unaffected, so the UI should say changes
    /// are still saved.
    private(set) var live = true
    private(set) var rejected = 0

    @ObservationIgnored private var sync: SyncClient?
    @ObservationIgnored private let api: AnsaAPI

    init(token: @escaping TokenSource = ClerkToken.current) {
        api = AnsaAPI(base: Config.apiBase, token: token, user: Config.devUser)
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
            await api.seedIfEmpty()
        }
    }

    /// Every edit goes through here, so there is exactly one path from a
    /// gesture to both the screen and the server.
    func apply(_ op: Op) {
        tree = TreeOps.applyOp(tree, op).tree
        sync?.send(op)
    }

    /// True while the user is editing — an incoming tree is stashed rather than
    /// swapped in under them.
    func setBusy(_ busy: Bool) {
        sync?.setBusy(busy)
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
}
