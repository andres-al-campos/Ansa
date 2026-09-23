import ClerkKit
import ClerkKitUI
import SwiftUI

/// The account control at the top of the sidebar: a circular avatar of the
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

/// The sidebar's top row: the avatar and whose account this is.
///
/// The name is what makes it a row rather than a lone circle — an avatar on
/// its own reads as decoration until you already know it is a button. The
/// avatar keeps the tap, since `UserButton` presents the account sheet itself.
///
/// Signed-in path only, like `AccountButton`, and for the same reason.
struct AccountRow: View {
    @Environment(Clerk.self) private var clerk

    private var name: String? {
        guard let user = clerk.user else { return nil }
        let full = [user.firstName, user.lastName]
            .compactMap { $0 }
            .joined(separator: " ")
        return full.isEmpty ? user.primaryEmailAddress?.emailAddress : full
    }

    var body: some View {
        HStack(spacing: 10) {
            AccountButton()
            if let name {
                Text(name)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
    }
}
