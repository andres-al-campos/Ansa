import ClerkKit
import ClerkKitUI
import SwiftUI

/// The account control in the home screen's header: a circular avatar of the
/// signed-in user that opens the account sheet (manage account, sign out) on
/// tap. Clerk's own `UserButton` does all of that — the image, the sheet, the
/// sign-out — so this is only the wrapper that sizes it into the header slot.
///
/// It lives in its own file, and behind `OutlineView`'s `signedIn` flag, for
/// one reason: `UserButton` reads `@Environment(Clerk.self)`, and the
/// `--no-auth` build runs with no Clerk in the environment. A view that reads a
/// Clerk that was never configured is a launch crash, not a nil — so this view
/// is only ever instantiated on the signed-in path.
struct AccountButton: View {
    var body: some View {
        // `UserButton` is a fixed 36pt circle; it clips its own image round and
        // presents the profile sheet itself. Nothing to size or wire here.
        UserButton()
    }
}
