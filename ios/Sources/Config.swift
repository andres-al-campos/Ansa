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
