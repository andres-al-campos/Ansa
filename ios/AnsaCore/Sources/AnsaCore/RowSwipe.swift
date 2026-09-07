import Foundation

/// The decisions a horizontal row swipe makes, with no view attached.
///
/// Extracted because every one of these rules was a bug at least once and none
/// of them were reachable from a test: the gesture lives in a SwiftUI row in
/// the app target, so the only way to check it was to swipe a simulator and
/// look. The view keeps the state and the animation; the answers live here.
public enum RowSwipe {
    /// The fraction of the screen a pull must cross to act on release.
    ///
    /// A quarter rather than the half UIKit uses: that one is tuned for a
    /// delete that ends the data, where this goes to a trash it stays
    /// restorable in.
    public static let commitFraction: CGFloat = 0.25

    /// How much of the pull past the commit point still shows.
    ///
    /// Rubber-banding, so the row keeps answering the finger while saying the
    /// useful part is done.
    public static let pastCommit: CGFloat = 0.35

    /// How long after a swipe lets go a tap is still treated as its tail.
    ///
    /// The spring back's own duration. A Button inside a List does not lose
    /// its touch to a sibling drag, so without a window every cancelled swipe
    /// opens the editor on the row it just released.
    public static let tapDeafness: TimeInterval = 0.22

    /// How long the row takes to travel home from a pull that did not commit.
    ///
    /// Also the window a tap is refused for — the two are the same duration on
    /// purpose, so the row stops being deaf exactly when it stops moving.
    public static let returnDuration: TimeInterval = 0.22

    /// The eased fraction of the return that is complete at `t`, where `t` runs
    /// 0 to 1 over `returnDuration`.
    ///
    /// Quadratic ease-out: fastest at the release, settling as it arrives. The
    /// return is driven a tick at a time rather than handed to SwiftUI, so this
    /// curve is applied by hand — and being here rather than in the view is
    /// what lets it be checked without a simulator.
    public static func returnEase(_ t: Double) -> Double {
        let t = min(max(t, 0), 1)
        return 1 - (1 - t) * (1 - t)
    }

    /// Where the row sits `elapsed` seconds into a return that began at `from`.
    public static func returnOffset(from: CGFloat, elapsed: TimeInterval) -> CGFloat {
        from * CGFloat(1 - returnEase(elapsed / returnDuration))
    }

    /// What either edge commits to.
    public enum Action: Equatable, Sendable {
        case zoom
        case delete
    }

    /// The action a pull of `translation` names, or nil if it has not moved.
    ///
    /// Follows the finger for the whole gesture rather than latching: a pull
    /// that starts rightward and comes back left is a zoom the user changed
    /// their mind about, and the row should say so.
    public static func action(for translation: CGFloat) -> Action? {
        if translation > 0 { return .zoom }
        if translation < 0 { return .delete }
        return nil
    }

    /// How far the row is drawn for a pull of `translation` on `screenWidth`.
    ///
    /// One-to-one up to the commit point, damped past it.
    public static func offset(for translation: CGFloat, screenWidth: CGFloat) -> CGFloat {
        let commit = screenWidth * commitFraction
        let m = abs(translation)
        let shown = m <= commit ? m : commit + (m - commit) * pastCommit
        return translation < 0 ? -shown : shown
    }

    /// Whether a pull of `translation` acts on release.
    public static func isArmed(_ translation: CGFloat, screenWidth: CGFloat) -> Bool {
        guard screenWidth > 0 else { return false }
        return abs(translation) >= screenWidth * commitFraction
    }

    /// Whether a tap arriving `elapsed` after a swipe let go is meant as a tap.
    public static func acceptsTap(elapsed: TimeInterval?) -> Bool {
        guard let elapsed else { return true }
        return elapsed >= tapDeafness
    }
}
