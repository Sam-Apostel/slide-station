import SwiftUI

public enum ProButtonSize: String, CaseIterable, Sendable {
    case sm, md, lg
    var height: CGFloat { self == .sm ? 22 : self == .md ? 25 : 32 }
    var padding: CGFloat { self == .sm ? 8 : self == .md ? 12 : 18 }
}

public struct ProButtonStyle: ButtonStyle {
    public var size: ProButtonSize
    public var active: Bool
    public var activeTint: Color?
    public var backgroundTint: Color?
    public var plain: Bool
    public var fullWidth: Bool
    public var topHighlightOpacity: Double
    public var height: CGFloat?
    public var hoverEffect: Bool
    @Environment(\.isEnabled) private var enabled
    @Environment(\.proGrouped) private var grouped

    public init(size: ProButtonSize = .sm, active: Bool = false, activeTint: Color? = nil, backgroundTint: Color? = nil, plain: Bool = false, fullWidth: Bool = false, topHighlightOpacity: Double = 0.35, height: CGFloat? = nil, hoverEffect: Bool = false) {
        self.height = height
        self.size = size; self.active = active; self.activeTint = activeTint; self.backgroundTint = backgroundTint
        self.plain = plain; self.fullWidth = fullWidth; self.topHighlightOpacity = topHighlightOpacity; self.hoverEffect = hoverEffect
    }
    public func makeBody(configuration: Configuration) -> some View {
        ProButtonPaint(configuration: configuration, size: size, active: active, activeTint: activeTint, backgroundTint: backgroundTint, plain: plain, fullWidth: fullWidth, topHighlightOpacity: topHighlightOpacity, height: height, hoverEffect: hoverEffect, enabled: enabled, grouped: grouped)
    }
}

private struct ProButtonPaint: View {
    let configuration: ButtonStyleConfiguration
    let size: ProButtonSize, active: Bool, activeTint: Color?, backgroundTint: Color?, plain: Bool, fullWidth: Bool, topHighlightOpacity: Double, height: CGFloat?, hoverEffect: Bool, enabled: Bool, grouped: Bool
    @State private var hovering = false
    private var radius: CGFloat { grouped ? 0 : 5 }
    var body: some View {
        let solid = active || backgroundTint != nil
        // Inactive members of a group no longer dim when a sibling is selected:
        // every segment keeps its own fill and ink, and only the active one reads
        // as pressed into the surface.
        let fill = active ? (activeTint ?? ProTheme.accent) : backgroundTint ?? Color.white.opacity(0.15)
        let highlightOpacity = active ? Swift.min(topHighlightOpacity, 0.1) * 0.65 : topHighlightOpacity * (solid ? 1 : 0.15) * 0.65
        configuration.label
            .font(.system(size: size == .lg ? 13 : 12))
            .foregroundStyle(active && activeTint == nil ? ProTheme.accentInk : Color.white.opacity(enabled ? 1 : 0.65)) // Slide Station: dark ink on amber
            .padding(.horizontal, size.padding)
            .frame(maxWidth: fullWidth ? .infinity : nil)
            .frame(height: height ?? size.height)
            .background(ProMaterial(fill: fill, radius: radius, shadeOpacity: active ? 0.2 : 0, lineWidth: grouped ? 0 : plain ? 0.6 : 0.5, highlightOpacity: highlightOpacity, highlightHeight: solid ? 2 : 3)
                .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous)))
            .overlay { if hoverEffect && hovering && enabled { RoundedRectangle(cornerRadius: radius, style: .continuous).fill(.white.opacity(0.025)) } }
            .overlay { if configuration.isPressed { RoundedRectangle(cornerRadius: radius, style: .continuous).fill(active ? .black.opacity(0.03) : .white.opacity(0.08)) } }
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .contentShape(Rectangle())
            .opacity(enabled ? 1 : 0.55)
            .proDisabledCursor(!enabled)
            .onHover { hovering = $0 }
    }
}

public struct ProButton<Label: View>: View {
    private let action: () -> Void
    private let label: Label
    private let style: ProButtonStyle
    public init(size: ProButtonSize = .sm, active: Bool = false, activeTint: Color? = nil, backgroundTint: Color? = nil, plain: Bool = false, fullWidth: Bool = false, topHighlightOpacity: Double = 0.35, height: CGFloat? = nil, hoverEffect: Bool = false, action: @escaping () -> Void, @ViewBuilder label: () -> Label) {
        self.action = action; self.label = label()
        style = ProButtonStyle(size: size, active: active, activeTint: activeTint, backgroundTint: backgroundTint, plain: plain, fullWidth: fullWidth, topHighlightOpacity: topHighlightOpacity, height: height, hoverEffect: hoverEffect)
    }
    public var body: some View { Button(action: action) { label }.buttonStyle(style).accessibilityAddTraits(style.active ? .isSelected : []) }
}
public extension ProButton where Label == Text {
    init(_ title: String, size: ProButtonSize = .sm, active: Bool = false, activeTint: Color? = nil, backgroundTint: Color? = nil, plain: Bool = false, fullWidth: Bool = false, topHighlightOpacity: Double = 0.35, height: CGFloat? = nil, hoverEffect: Bool = false, action: @escaping () -> Void) {
        self.init(size: size, active: active, activeTint: activeTint, backgroundTint: backgroundTint, plain: plain, fullWidth: fullWidth, topHighlightOpacity: topHighlightOpacity, height: height, hoverEffect: hoverEffect, action: action) { Text(title) }
    }
}
public struct ProButtonGroup<Content: View>: View {
    private let content: Content
    public init(@ViewBuilder content: () -> Content) { self.content = content() }
    public var body: some View {
        // Nothing here needs to know whether a sibling is selected any more:
        // each segment paints itself.
        _VariadicView.Tree(ProButtonGroupLayout()) { content }
            .environment(\.proGrouped, true)
            .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(.black.opacity(0.2), lineWidth: 0.3) }
            .shadow(color: .black.opacity(0.06), radius: 1, y: 1)
    }
}
private struct ProButtonGroupLayout: _VariadicView_MultiViewRoot {
    func body(children: _VariadicView.Children) -> some View {
        HStack(spacing: 0) {
            ForEach(Array(children.enumerated()), id: \.element.id) { index, child in
                child.overlay(alignment: .leading) { if index > 0 { Rectangle().fill(.black.opacity(0.2)).frame(width: 0.6) } }
            }
        }
    }
}
