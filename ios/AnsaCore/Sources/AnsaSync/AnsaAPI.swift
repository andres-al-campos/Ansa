import AnsaCore
import Foundation

/// What became of a write.
///
/// The distinction is the whole point, and mirrors `WriteResult` in
/// `src/api.ts`. `unreachable` is about the network and says nothing about the
/// op, so retrying is right. `rejected` is the server's verdict on *this* op —
/// it will answer the same way every time, so retrying is not persistence, it
/// is a permanent stall that blocks every edit behind it.
public enum WriteResult: Sendable, Equatable {
    case ok
    case unreachable
    case rejected(reason: String)
}

/// How to get the current Clerk session token.
///
/// A closure rather than a value because these tokens are short-lived — Clerk
/// rotates them roughly every minute, so anything cached would start failing a
/// few minutes into a session. Returns nil when signed out, which leaves the
/// dev-stub user header as the only credential.
public typealias TokenSource = @Sendable () async -> String?

/// Client for the Ansa API. The server owns the tree; this is one of its
/// clients, alongside the web app and the MCP.
public actor AnsaAPI {
    private let base: URL
    private let session: URLSession
    private let token: TokenSource
    private let user: String

    /// Whether this build signs in. True means the `user` query fallback is
    /// dead code that the server will refuse, so a missing token is a reason to
    /// wait rather than to try and fail.
    private let authenticated: Bool

    /// A per-install id sent on every write. The server echoes it on the
    /// broadcast, so this client recognises its own change coming back and
    /// skips re-adopting it — which is what stops a local edit being clobbered
    /// by its own echo.
    ///
    /// Persisted rather than minted per launch: two installs sharing an origin
    /// is a silent bug (each mistakes the other's broadcasts for its own echo
    /// and quietly stops syncing), and a UUID makes that collision impossible.
    public let origin: String

    public init(
        base: URL,
        token: @escaping TokenSource,
        user: String = "legacy",
        authenticated: Bool = false,
        session: URLSession = .shared,
        defaults: UserDefaults = .standard
    ) {
        self.base = base
        self.token = token
        self.user = user
        self.authenticated = authenticated
        self.session = session

        let key = "ansa.origin.v1"
        if let existing = defaults.string(forKey: key) {
            origin = existing
        } else {
            origin = "ios-\(UUID().uuidString)"
            defaults.set(origin, forKey: key)
        }
    }

    /// The headers every request carries. One place, so adding a call site
    /// cannot mean silently omitting identity and getting someone else's tree.
    ///
    /// Both credentials go out: the bearer token for a Clerk server, the user
    /// header for a stub server. Each ignores the other's, so one build works
    /// against either.
    private func headers() async -> [String: String] {
        var h = [
            "content-type": "application/json",
            "x-ansa-origin": origin,
            "x-ansa-user": user,
        ]
        if let t = await token() { h["authorization"] = "Bearer \(t)" }
        return h
    }

    private func request(_ path: String, method: String, body: Data? = nil) async -> URLRequest {
        var req = URLRequest(url: base.appending(path: path))
        req.httpMethod = method
        req.httpBody = body
        // Never answer a tree request from the URL cache. Every call here asks
        // for live state, and a cached 200 is indistinguishable from a fresh
        // one at the call site — the app comes up rendering an old tree while
        // believing it is in sync, which is worse than showing nothing.
        req.cachePolicy = .reloadIgnoringLocalCacheData
        for (k, v) in await headers() { req.setValue(v, forHTTPHeaderField: k) }
        return req
    }

    /// The server's tree. Nil when it could not be reached or did not answer
    /// with one — the caller keeps showing its cached tree in that case.
    public func loadTree() async -> Tree? {
        let req = await request("/api/tree", method: "GET")
        guard let (data, response) = try? await session.data(for: req),
            (response as? HTTPURLResponse)?.statusCode == 200
        else { return nil }
        return try? JSONDecoder().decode(TreeEnvelope.self, from: data).tree
    }

    /// Send one operation. The server replays it against its current tree, so
    /// an op made against a slightly stale local tree merges instead of
    /// clobbering.
    ///
    /// A rejection is not necessarily a bug. The common cause is a race no
    /// ordering can fix: this device adds a child to a project another device
    /// deleted a moment ago, so by the time the op lands its parent is gone.
    public func send(_ op: Op) async -> WriteResult {
        guard let body = try? JSONEncoder().encode(OpEnvelope(op: op)) else {
            // Encoding an op cannot fail for any op the type system allows, so
            // this is a client bug rather than a server verdict. Rejected
            // anyway: retrying forever would stall every edit behind it.
            return .rejected(reason: "Could not encode the edit.")
        }
        let req = await request("/api/ops", method: "POST", body: body)

        guard let (data, response) = try? await session.data(for: req),
            let http = response as? HTTPURLResponse
        else {
            // Never reached the server: offline, DNS, a blocked request. The op
            // is still good.
            return .unreachable
        }

        if (200..<300).contains(http.statusCode) { return .ok }
        // 401/403 are about the session, not the op: a Clerk token expires
        // roughly every minute, and the op is still perfectly good once a fresh
        // one is fetched. Discarding edits because a token aged out would lose
        // real work.
        if http.statusCode == 401 || http.statusCode == 403 { return .unreachable }
        // 4xx is a verdict on the op. 5xx is the server failing at its own job,
        // which says nothing about whether the op is valid — so that retries
        // like a network failure rather than being thrown away.
        guard (400..<500).contains(http.statusCode) else { return .unreachable }
        let reason =
            (try? JSONDecoder().decode(ErrorEnvelope.self, from: data).error)
            ?? "HTTP \(http.statusCode)"
        return .rejected(reason: reason)
    }

    /// Ask the server to give a brand-new account its tutorial project.
    ///
    /// Safe on every boot: the server refuses when the tree is non-empty, so
    /// this cannot overwrite anything. Failure is silent by design — an empty
    /// outliner is a working outliner.
    @discardableResult
    public func seedIfEmpty() async -> Bool {
        var req = await request("/api/seed", method: "POST")
        // No content-type on a bodyless POST: Fastify rejects an empty body
        // declared as application/json before the route runs, which is how this
        // silently did nothing on the web at first.
        req.setValue(nil, forHTTPHeaderField: "content-type")
        guard let (_, response) = try? await session.data(for: req) else { return false }
        return (response as? HTTPURLResponse)?.statusCode == 200
    }

    /// The live stream's URL, carrying a credential in the query string.
    ///
    /// The query string is forced, not chosen: a WebSocket handshake cannot set
    /// an Authorization header. What makes it acceptable is that a Clerk
    /// session token expires in about a minute, so a URL that leaks into a log
    /// is stale by the time anyone reads it. A long-lived key here would not be.
    ///
    /// Rebuilt per connection rather than cached, because a reconnect needs a
    /// *fresh* token — reusing the original URL authenticates with an expired
    /// one and is refused, leaving the app silently deaf.
    public func eventsURL() async -> URL? {
        guard var parts = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            return nil
        }
        // http→ws and https→wss. Hardcoding either breaks one environment:
        // `wss` fails against a local plaintext Worker, `ws` is refused from a
        // secure origin.
        parts.scheme = parts.scheme == "https" ? "wss" : "ws"
        parts.path = "/api/events"
        if let t = await token() {
            parts.queryItems = [URLQueryItem(name: "token", value: t)]
        } else if authenticated {
            // No URL rather than the `user` fallback. On a build that signs in,
            // that fallback cannot work — the server refuses it — so using it
            // turns "the token isn't ready yet" into a failed handshake, and
            // three of those raise the out-of-sync banner.
            //
            // A nil token is routine, not an outage: Clerk rotates roughly
            // every minute, and the session takes a moment to restore after
            // launch or a return from background. Those are moments to wait
            // through, and the reconnect ladder comes back on its own.
            return nil
        } else {
            parts.queryItems = [URLQueryItem(name: "user", value: user)]
        }
        return parts.url
    }
}

/// `{"tree": [...]}` — the shape of both `GET /api/tree` and every broadcast.
struct TreeEnvelope: Decodable {
    let tree: Tree
}

/// `{"op": {...}}`, the body `POST /api/ops` expects.
struct OpEnvelope: Encodable {
    let op: Op
}

/// `{"error": "..."}` — how the server explains a 4xx.
struct ErrorEnvelope: Decodable {
    let error: String
}

/// A broadcast frame: the new tree, stamped with whoever caused it.
public struct Broadcast: Decodable, Sendable {
    public let tree: Tree
    /// The `x-ansa-origin` of the client whose write this was, or nil for a
    /// change with no client behind it. Matching our own means this is the echo
    /// of our own edit and must not be re-adopted.
    public let origin: String?

    public init(tree: Tree, origin: String?) {
        self.tree = tree
        self.origin = origin
    }
}
