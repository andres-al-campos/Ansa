import ClerkKit
import ClerkKitUI
import SwiftUI

@main
struct AnsaApp: App {
    /// Nil when the build had no publishable key — see init.
    @State private var clerk: Clerk?

    init() {
        // Configure before anything reads Clerk.shared — reading it first is a
        // hard crash inside ClerkKit, not a nil.
        //
        // This assignment cannot become a property initializer (`= Clerk.shared`
        // on the declaration). Swift runs those *before* init's body, so the
        // read would happen before configure and crash on launch every time.
        // It is a one-line change that looks equivalent and is not.
        guard let key = ClerkConfig.publishableKey else {
            // No key: run unauthenticated against a dev-stub server rather than
            // taking the app down. Clerk.shared is never touched in this mode —
            // reading it unconfigured is a fatalError inside ClerkKit.
            _clerk = State(initialValue: nil)
            return
        }
        Clerk.configure(publishableKey: key)
        _clerk = State(initialValue: Clerk.shared)
    }

    var body: some Scene {
        WindowGroup {
            if let clerk {
                RootView()
                    .environment(clerk)
            } else {
                // The outliner still works; every write goes out with the dev
                // user header instead of a bearer token.
                OutlineView()
            }
        }
    }
}

/// Sign-in, or the outliner.
///
/// Two conditions, and both matter:
///
/// `isLoaded` — on a cold start with a stored session, Clerk needs a moment
/// before it knows who this is. Without this check the sign-in screen flashes
/// at someone who is already signed in, inviting them to sign in again while a
/// perfectly good session is still loading.
///
/// `isAuthFlowComplete` rather than `user != nil` — a user can exist while the
/// flow is still mid-way through a second factor or a required field. Gating on
/// the user alone drops someone into the outliner in a half-authenticated state
/// whose token the server will refuse.
private struct RootView: View {
    @Environment(Clerk.self) private var clerk

    var body: some View {
        if !clerk.isLoaded {
            ProgressView()
        } else if clerk.isAuthFlowComplete {
            OutlineView()
        } else {
            // Non-dismissible: there is no signed-out mode to fall back to, so
            // a dismissable sheet would just leave an empty screen behind it.
            AuthView(isDismissible: false)
        }
    }
}
