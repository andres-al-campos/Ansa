import ClerkKit
import Foundation

/// The bridge from Clerk to the API client.
///
/// `AnsaSync` deliberately knows nothing about Clerk — it takes a closure that
/// produces a token. That keeps the sync layer testable without an auth SDK,
/// and means swapping providers touches this file and nothing else.
enum ClerkToken {
    /// A fresh session token, or nil when signed out.
    ///
    /// Fetched per request rather than cached anywhere: Clerk rotates these
    /// roughly every minute, so a cached copy starts failing a few minutes into
    /// a session. `getToken` returns the current one and refreshes it when it is
    /// close to expiry, which is why calling it often is the correct usage
    /// rather than a waste.
    ///
    /// A thrown error is a nil token, not a crash. Offline, or mid-rotation,
    /// this fails routinely — and the layer above already treats a missing
    /// credential as `unreachable`, so the op waits in the queue and goes out
    /// when auth recovers. Losing an edit over a momentarily unavailable token
    /// would be the real bug.
    @Sendable
    static func current() async -> String? {
        // Reading Clerk.shared unconfigured is a fatalError inside ClerkKit,
        // not a nil — so a keyless build must not reach it. That mode runs
        // unauthenticated against a dev-stub server.
        guard ClerkConfig.publishableKey != nil else { return nil }
        guard let session = await Clerk.shared.session else { return nil }
        return try? await session.getToken()
    }
}
