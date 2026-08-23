/// The two colours a drag speaks in.
///
/// Brass means the row becomes a parent. Blue means the row goes in a gap.
/// One meaning each, never mixed — during a drag those are the only two things
/// that can happen, and shape alone does not separate them fast enough at the
/// moment of release.
///
/// Both are the web's tokens (`--brass`, `--bar` in `src/index.css`) rather
/// than the system accent, so the same drop reads the same on both screens.
/// The system accent still owns everything that is not a drag — swipe actions,
/// progress bars — because those follow the user's own tint.

import SwiftUI

enum DropPalette {

    /// "This becomes the parent." Warm, and the only warm thing on the screen.
    static let nest = Color(
        light: Color(red: 0.612, green: 0.435, blue: 0.157),
        dark: Color(red: 0.827, green: 0.643, blue: 0.361))

    /// "It goes in this gap." The insertion line and its dot.
    static let insert = Color(
        light: Color(red: 0.290, green: 0.482, blue: 0.710),
        dark: Color(red: 0.435, green: 0.624, blue: 0.847))
}

extension Color {
    /// A colour that follows the interface style.
    ///
    /// SwiftUI has no literal for this the way CSS has a media query, so the
    /// pair goes through UIKit's dynamic provider. Without it a brass tuned for
    /// white sits on a dark row at roughly the contrast of the row itself.
    init(light: Color, dark: Color) {
        self = Color(UIColor { traits in
            UIColor(traits.userInterfaceStyle == .dark ? dark : light)
        })
    }
}
