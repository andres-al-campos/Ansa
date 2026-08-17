import Foundation

/// The Clerk publishable key, baked into the bundle at build time.
///
/// Three things about where this lives, because each of them is a decision that
/// looks wrong from one angle:
///
///  - **Not committed.** It names one Clerk instance, so it is account state
///    rather than something a fresh clone should inherit. It comes from the
///    macOS login Keychain via build.sh.
///
///  - **Not read from the Keychain at runtime.** An iOS app cannot see the
///    Mac's login Keychain — the simulator has its own, a device has the app's.
///    The Keychain is the *source*, and the build is what carries the value
///    across.
///
///  - **Not a secret.** A publishable key is designed to ship inside every
///    client; anyone with the app has it. It is kept out of git for
///    portability, not for secrecy, and it needs no protection at rest here.
///    The secret key is a different value and lives only on the Worker.
enum ClerkConfig {
    /// The key, or nil if the build had none.
    ///
    /// Optional rather than a crash: a missing key means auth cannot start, but
    /// the outliner still works against the dev-stub server, and taking the
    /// whole app down for it would make local development strictly worse.
    static var publishableKey: String? {
        guard
            let value = Bundle.main.object(forInfoDictionaryKey: "ANSAClerkPublishableKey")
                as? String,
            !value.isEmpty,
            // An unsubstituted build setting arrives as the literal
            // "$(ANSA_CLERK_PUBLISHABLE_KEY)". Treated as absent, because
            // handing that to Clerk fails far from the actual cause.
            !value.hasPrefix("$(")
        else { return nil }
        return value
    }
}
