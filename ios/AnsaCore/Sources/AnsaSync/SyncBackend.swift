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
/// The socket is deliberately not here. `SyncClient` opens it from
/// `eventsURL()` with `URLSession` directly, and a protocol returning a URL
/// cannot fake what comes back over it — so a test drives incoming frames
/// through `receiveForTesting` instead of standing up a WebSocket server.
public protocol SyncBackend: Sendable {
    /// This install's id, echoed on broadcasts so a client can spot its own.
    var origin: String { get }

    /// The server's current tree, or nil when it could not be reached.
    func loadTree() async -> Tree?

    /// Ship one op. The three results mean different things — see `WriteResult`.
    func send(_ op: Op) async -> WriteResult

    /// The live stream's URL, with a fresh credential. Nil when none is available.
    func eventsURL() async -> URL?
}

extension AnsaAPI: SyncBackend {}
