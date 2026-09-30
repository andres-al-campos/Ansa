/// The two colours a drag speaks in: brass means the row becomes a parent,
/// blue means it goes in a gap. One meaning each, never mixed.
///
/// The web's `--brass` and `--bar` (`src/index.css`) rather than the system
/// accent, so the same drop reads the same on both screens.

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

/// Found: the matched words in Search, and the flash on the row a result
/// opens onto.
///
/// `DropPalette.nest`'s brass as a light fill, without the ring that makes a
/// drop target read as "drop here". A drag and an arrival never share the
/// screen, so the shared hue is not read as the same thing.
enum FoundPalette {
    static let mark = Color(
        light: Color(red: 0.612, green: 0.435, blue: 0.157).opacity(0.17),
        dark: Color(red: 0.827, green: 0.643, blue: 0.361).opacity(0.24))
}

/// The two colours a ticked box speaks in: green when the group is finished
/// too, blue when the task is done but the group is not.
///
/// Kept separate from `DropPalette` despite sharing the blue — that one means
/// "what this drop will do", and one enum for two vocabularies is how a colour
/// acquires a second meaning.
enum DonePalette {

    /// Done, and so is everything around it.
    static let group = Color(
        light: Color(red: 0.173, green: 0.455, blue: 0.341),
        dark: Color(red: 0.392, green: 0.718, blue: 0.584))

    /// Done, but the group it sits in is not finished.
    static let task = Color(
        light: Color(red: 0.290, green: 0.482, blue: 0.710),
        dark: Color(red: 0.435, green: 0.624, blue: 0.847))
}

extension Color {
    /// "Done", dark enough to read on white. `Color.green` is tuned for a dark
    /// ground and lands near 2.3:1 on white, under the 4.5:1 this size needs.
    static let done = Color(
        light: Color(red: 0.10, green: 0.45, blue: 0.20), dark: .green)

    /// A colour that follows the interface style. SwiftUI has no literal for
    /// this, so the pair goes through UIKit's dynamic provider.
    init(light: Color, dark: Color) {
        self = Color(UIColor { traits in
            UIColor(traits.userInterfaceStyle == .dark ? dark : light)
        })
    }
}
