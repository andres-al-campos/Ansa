import Foundation

/// Where the app looks for the API.
///
/// Not in Config.xcconfig, where the rest of the machine-specific build
/// settings live: xcconfig treats `//` as a comment even in the middle of a
/// value, so `http://localhost:8787` silently becomes `http:`. That failure
/// shows up as a confusing connection error at runtime rather than a build
/// error, so the URL is set here in Swift where it means what it says.
enum Config {
    /// A `wrangler dev` on the host machine. The simulator shares the host's
    /// network, so localhost reaches it; a physical device does not, and needs
    /// the Mac's LAN address here instead.
    static let devAPI = URL(string: "http://localhost:8787")!

    /// The deployed Worker — the same API the web app at ansaflow.pages.dev
    /// uses, so both clients address the same Durable Object per account.
    static let prodAPI = URL(string: "https://ansa.id3arium.workers.dev")!

    /// Who a debug build claims to be when the local Worker is running its dev
    /// stub (no Clerk key configured).
    ///
    /// The stub keys each account's Durable Object off this header, so a
    /// distinct name here is a completely separate tree. That is the point: the
    /// simulator can be developed against without any risk to the real `legacy`
    /// tree the browser is using on the same server. A Clerk-backed server
    /// ignores this entirely and uses the bearer token.
    static let devUser = "ios-dev"

    /// Debug builds talk to the local Worker so the phone exercises the same
    /// backend `./build.sh` runs.
    static var apiBase: URL {
        #if DEBUG
            devAPI
        #else
            prodAPI
        #endif
    }
}
