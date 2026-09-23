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

func proModifierScale() -> Double {
    #if os(macOS)
    let flags = NSEvent.modifierFlags
    return flags.contains(.option) ? 0.2 : flags.contains(.shift) ? 5 : 1
    #else
    return 1
    #endif
}

struct ProRangeKeyboard: ViewModifier {
    let enabled: Bool
    let value: Double, min: Double, max: Double, step: Double
    let update: (Double) -> Void
    var commit: (() -> Void)?
    var edit: (() -> Void)?
    var cancel: (() -> Void)?
    var interactionStarted: (() -> Void)?
    func body(content: Content) -> some View {
        content.focusable(enabled).focusEffectDisabled()
            .onKeyPress(phases: [.down, .repeat]) { press in
                guard enabled else { return .ignored }
                let scale = press.modifiers.contains(.option) ? 0.2 : press.modifiers.contains(.shift) ? 5.0 : 1.0
                let next: Double
                switch press.key {
                case .upArrow, .rightArrow: next = value + step * scale
                case .downArrow, .leftArrow: next = value - step * scale
                case .home: next = min
                case .end: next = max
                case .return, .space:
                    guard let edit else { return .ignored }; edit(); return .handled
                case .escape:
                    guard let cancel else { return .ignored }; cancel(); return .handled
                default: return .ignored
                }
                interactionStarted?()
                update(next); commit?(); return .handled
            }
    }
}

struct ProChevron: Shape {
    var down = true
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let s = rect.width / 11
        path.move(to: CGPoint(x: s, y: (down ? 0.9 : 2.7) * rect.height / 3.6))
        path.addLine(to: CGPoint(x: 5.5 * s, y: (down ? 2.5 : 1.1) * rect.height / 3.6))
        path.addLine(to: CGPoint(x: 10 * s, y: (down ? 0.9 : 2.7) * rect.height / 3.6))
        return path
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
