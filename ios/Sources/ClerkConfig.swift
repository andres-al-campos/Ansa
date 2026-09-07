import Foundation

/// The Clerk publishable key, baked into the bundle at build time from the
/// macOS login Keychain by build.sh.
///
/// An iOS app cannot read the Mac's login Keychain, so the build is what
/// carries the value across. The key is public by design — it ships in every
/// client — and is kept out of git because it names one Clerk instance, not
/// because it needs protecting. The secret key lives only on the Worker.
enum ClerkConfig {
    /// The key, or nil if the build had none. A missing key means auth cannot
    /// start, but the outliner still works against the dev-stub server, so this
    /// does not crash.
    static var publishableKey: String? {
        guard
            let value = Bundle.main.object(forInfoDictionaryKey: "ANSAClerkPublishableKey")
                as? String,
            !value.isEmpty,
            // An unsubstituted build setting arrives as the literal
            // "$(ANSA_CLERK_PUBLISHABLE_KEY)". Handing that to Clerk fails far
            // from the actual cause.
            !value.hasPrefix("$(")
        else { return nil }
        return value
    }
}
