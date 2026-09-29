import ObjectiveC
import UIKit

extension Notification.Name {
    /// Backspace pressed in a text view that was already empty. The object is
    /// the `UITextView`. See `EmptyBackspace`.
    static let emptyBackspace = Notification.Name("ansa.emptyBackspace")
}

/// Reports Backspace on an empty field, which SwiftUI has no way to say.
///
/// A `TextField` only reports changes to its text, and Backspace on nothing
/// changes nothing. `onKeyPress` hears hardware keyboards only. What does see
/// the key is `deleteBackward` on the `UITextView` behind a vertical-axis
/// `TextField`, so this wraps that method for every text view in the app and
/// posts when the view was empty. Posting is all it does: the original always
/// runs, and a view nobody listens for behaves exactly as before.
///
/// Nothing here tells a held key from a fresh press. On the simulator the
/// keyboard stops repeating once the text is empty, so a hold only clears. If
/// a device keeps going, the row is deleted, as a held Backspace does on the
/// web — and the listener ends the edit, so it stops at one row.
enum EmptyBackspace {
    static func install() { _ = installed }

    private static let installed: Void = {
        let selector = #selector(UITextView.deleteBackward)
        guard let method = class_getInstanceMethod(UITextView.self, selector) else { return }
        typealias Original = @convention(c) (UITextView, Selector) -> Void
        let original = unsafeBitCast(method_getImplementation(method), to: Original.self)
        let wrapped: @convention(block) (UITextView) -> Void = { view in
            // UIKit only calls this on the main thread. The original runs
            // outside the isolated blocks, which is what lets them not capture
            // it.
            let empty = MainActor.assumeIsolated { !view.hasText }
            original(view, selector)
            guard empty else { return }
            MainActor.assumeIsolated {
                NotificationCenter.default.post(name: .emptyBackspace, object: view)
            }
        }
        let replacement = imp_implementationWithBlock(wrapped)
        // Added to `UITextView` itself if it only inherits the method, so the
        // wrapper never lands on a class other text inputs share.
        if !class_addMethod(
            UITextView.self, selector, replacement, method_getTypeEncoding(method))
        {
            method_setImplementation(method, replacement)
        }
    }()
}
