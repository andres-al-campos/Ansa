import ClerkKit
import Foundation

/// The bridge from Clerk to the API client.
///
/// `AnsaSync` takes a closure that produces a token rather than knowing about
/// Clerk, which keeps the sync layer testable without an auth SDK.
enum ClerkToken {
    /// A fresh session token, or nil when signed out.
    ///
    /// Fetched per request rather than cached: Clerk rotates these roughly every
    /// minute, and `getToken` refreshes when close to expiry, so calling it
    /// often is the correct usage.
    ///
    /// A thrown error is a nil token, not a crash. Offline or mid-rotation this
    /// fails routinely, and the layer above treats a missing credential as
    /// `unreachable` — the op waits in the queue and goes out when auth recovers.
    @Sendable
    static func current() async -> String? {
        // Reading Clerk.shared unconfigured is a fatalError inside ClerkKit,
        // not a nil, so a keyless build must not reach it.
        guard ClerkConfig.publishableKey != nil else { return nil }
        guard let session = await Clerk.shared.session else { return nil }
        return try? await session.getToken()
    }
}
