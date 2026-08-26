import AnsaCore
import Foundation

/// The server, as far as `SyncClient` is concerned.
///
/// Extracted so the sync state machine can be tested without a server. That
/// machine is all timing — what is held back until the first adopt, what order
/// writes leave in, what is stashed while the user types, how many failures
/// count as deaf — and every one of those is invisible against a real network:
/// the interesting states are the rare ones, and provoking them by unplugging
/// wifi at the right instant is not a test.
///
/// `AnsaAPI` is the production conformer. It is an actor, so the members are
/// `async` whether or not an implementation needs to be.
///
/// The socket is here too, as `connect()`. It used to be deliberately absent —
/// `SyncClient` opened it from `eventsURL()` with `URLSession` directly — but
/// that left the reconnect ladder untestable, and it was the ladder that had
/// the bug: a healthy idle socket was indistinguishable from a refused one, so
/// the backoff climbed to its ceiling and the app went deaf while looking fine.
/// `EventStream` separates the handshake from the first frame, which is what
/// makes the difference expressible.
public protocol SyncBackend: Sendable {
    /// This install's id, echoed on broadcasts so a client can spot its own.
    var origin: String { get }

    /// The server's current tree, or nil when it could not be reached.
    func loadTree() async -> Tree?

    /// Ship one op. The three results mean different things — see `WriteResult`.
    func send(_ op: Op) async -> WriteResult

    /// The live stream's URL, with a fresh credential. Nil when none is available.
    func eventsURL() async -> URL?

    /// Open one live connection, or nil when there is no URL to open it with.
    ///
    /// One per attempt rather than one reused: a reconnect needs a fresh token,
    /// since a Clerk session token expires in about a minute.
    func connect() async -> (any EventStream)?
}

extension SyncBackend {
    /// The real socket, for anything that hasn't a reason to do otherwise.
    public func connect() async -> (any EventStream)? {
        guard let url = await eventsURL() else { return nil }
        return WebSocketStream(url: url)
    }
}

extension AnsaAPI: SyncBackend {}
