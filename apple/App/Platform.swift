import SwiftUI

// The same views on iPhone, iPad and the Mac. UIKit-only bits get a stand-in on the Mac, so the
// views read the same everywhere (a Mac window is always "regular": the Studio layout).

#if os(macOS)
import AppKit

typealias PlatformImage = NSImage

extension NSImage {
    convenience init(cgImage: CGImage) { self.init(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height)) }
}

extension Image {
    init(uiImage: NSImage) { self.init(nsImage: uiImage) }
}

/// A Mac window has no size classes; it's laid out like an iPad in landscape.
enum UserInterfaceSizeClass { case compact, regular }
private struct HorizontalSizeClassKey: EnvironmentKey { static let defaultValue: UserInterfaceSizeClass? = .regular }
private struct VerticalSizeClassKey: EnvironmentKey { static let defaultValue: UserInterfaceSizeClass? = .regular }
extension EnvironmentValues {
    var horizontalSizeClass: UserInterfaceSizeClass? {
        get { self[HorizontalSizeClassKey.self] }
        set { self[HorizontalSizeClassKey.self] = newValue }
    }
    var verticalSizeClass: UserInterfaceSizeClass? {
        get { self[VerticalSizeClassKey.self] }
        set { self[VerticalSizeClassKey.self] = newValue }
    }
}

enum UIKeyboardType { case `default`, URL, numberPad, numbersAndPunctuation }
enum TextInputAutocapitalization { case never }
enum NavigationBarTitleDisplayMode { case inline }

extension View {
    func keyboardType(_: UIKeyboardType) -> some View { self }
    func textInputAutocapitalization(_: TextInputAutocapitalization?) -> some View { self }
    func navigationBarTitleDisplayMode(_: NavigationBarTitleDisplayMode) -> some View { self }
    /// A sheet on the Mac: there's no full-screen cover, and a slideshow gets its own big sheet.
    func fullScreenCover<Item: Identifiable, Content: View>(item: Binding<Item?>, @ViewBuilder content: @escaping (Item) -> Content) -> some View {
        sheet(item: item) { content($0).frame(minWidth: 960, idealWidth: 1280, minHeight: 640, idealHeight: 820) }
    }
    func idleTimerDisabled() -> some View { self }
}
#else
import UIKit

typealias PlatformImage = UIImage

extension View {
    /// The screen stays on while a slideshow plays.
    func idleTimerDisabled() -> some View {
        onAppear { UIApplication.shared.isIdleTimerDisabled = true }
            .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
    }
}
#endif

extension PlatformImage {
    /// Width over height.
    var aspect: Double { size.height > 0 ? Double(size.width / size.height) : 1.5 }
}

enum Platform {
    #if os(macOS)
    static let isMac = true
    #else
    static let isMac = false
    #endif
    /// Studio (the detailed tools) is where the Mac starts; iPhone and iPad start Simple.
    static let studioDefault = isMac
}
