import Foundation

/// Where the app looks for the API.
///
/// Not in Config.xcconfig with the rest of the machine-specific build settings:
/// xcconfig treats `//` as a comment even mid-value, so `http://localhost:8787`
/// silently becomes `http:` and fails as a connection error at runtime rather
/// than a build error.
enum Config {
    /// A `wrangler dev` on the host machine. The simulator shares the host's
    /// network, so localhost reaches it; a physical device does not, and needs
    /// the Mac's LAN address here instead.
    static let devAPI = URL(string: "http://localhost:8787")!

    /// The deployed Worker — the same API the web app uses, so both clients
    /// address the same Durable Object per account.
    static let prodAPI = URL(string: "https://ansa.id3arium.workers.dev")!

    /// Who a debug build claims to be against the local Worker's dev stub: the
    /// one test user every client defaults to, so the simulator, the browser and
    /// the MCP all see the same tree. A Clerk-backed server ignores this and
    /// uses the bearer token.
    static let devUser = "legacy"

    static var apiBase: URL {
        #if DEBUG
            devAPI
        #else
            prodAPI
        #endif
    }
}
