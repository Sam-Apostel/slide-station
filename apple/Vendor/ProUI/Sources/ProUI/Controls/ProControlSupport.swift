import SwiftUI
#if os(macOS)
import AppKit
#endif

#if os(macOS)
/// A cursor rect owned by AppKit rather than by SwiftUI hit testing.
///
/// `.disabled()` withdraws a view from SwiftUI's interaction layer, so `onHover`
/// stops firing — the same reason the web kit had to drop `pointer-events-none`
/// to keep showing a cursor over a dead control. Cursor rects are resolved by
/// the window instead, so they survive both `.disabled()` and
/// `.allowsHitTesting(false)`.
struct ProCursorRegion: NSViewRepresentable {
    let cursor: NSCursor
    final class CursorView: NSView {
        var cursor: NSCursor = .arrow
        override func resetCursorRects() {
            super.resetCursorRects()
            addCursorRect(bounds, cursor: cursor)
        }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
    func makeNSView(context: Context) -> CursorView {
        let view = CursorView(frame: .zero)
        view.cursor = cursor
        return view
    }
    func updateNSView(_ view: CursorView, context: Context) {
        view.cursor = cursor
        view.window?.invalidateCursorRects(for: view)
    }
}
#endif

public extension View {
    /// A disabled control says no, whatever cursor it carries while it is live.
    @ViewBuilder func proDisabledCursor(_ disabled: Bool) -> some View {
        #if os(macOS)
        if disabled {
            overlay { ProCursorRegion(cursor: .operationNotAllowed).allowsHitTesting(false) }
        } else { self }
        #else
        self
        #endif
    }
}

/// The selected-segment recess shared by scope buttons and inspector tabs.
///
/// A shadow falling inside the top edge, a hairline, and a light caught on the
/// outside of the bottom edge — the segment sits *in* the surface rather than
/// being outlined on top of it.
struct ProRecessedFill<S: InsettableShape>: ViewModifier {
    var active: Bool
    var shape: S
    func body(content: Content) -> some View {
        content
            .overlay { if active { shape.strokeBorder(.black.opacity(0.28), lineWidth: 2).blur(radius: 1).mask(alignment: .top) { Rectangle().frame(height: 3) } } }
            .overlay { if active { shape.strokeBorder(.black.opacity(0.25), lineWidth: 0.5) } }
            .clipShape(shape)
            .background { if active { shape.fill(.white.opacity(0.08)).offset(y: 0.5) } }
    }
}

struct ProMaterial: View {
    var fill: Color
    var radius: CGFloat = 5
    var shadeOpacity = 0.0
    var lineOpacity = 0.2
    var lineWidth: CGFloat = 0.5
    var highlightOpacity = 0.035
    var highlightHeight: CGFloat = 3
    var body: some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .fill(fill)
            .overlay { RoundedRectangle(cornerRadius: radius, style: .continuous).fill(.black.opacity(shadeOpacity)) }
            .overlay(alignment: .top) {
                LinearGradient(stops: [.init(color: .white.opacity(highlightOpacity), location: 0), .init(color: .white.opacity(highlightOpacity * 0.38), location: 0.33), .init(color: .clear, location: 1)], startPoint: .top, endPoint: .bottom)
                    .frame(height: highlightHeight).padding(.top, 0.5)
            }
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(.black.opacity(lineOpacity), lineWidth: lineWidth) }
    }
}

private struct ProGroupedKey: EnvironmentKey { static let defaultValue = false }
extension EnvironmentValues {
    var proGrouped: Bool { get { self[ProGroupedKey.self] } set { self[ProGroupedKey.self] = newValue } }
}
