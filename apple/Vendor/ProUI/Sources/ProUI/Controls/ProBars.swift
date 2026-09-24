import SwiftUI

public struct ProToolbar<Content: View>: View {
    let content: Content
    public init(@ViewBuilder content: () -> Content) { self.content = content() }
    public var body: some View {
        HStack(spacing: 6) { content }.padding(.horizontal, 10).frame(maxWidth: .infinity, alignment: .leading).frame(height: 43)
            .background(LinearGradient(colors: [ProTheme.panel, ProTheme.bar], startPoint: .top, endPoint: .bottom))
            .overlay(alignment: .top) { Rectangle().fill(.white.opacity(0.08)).frame(height: 1) }
            .overlay(alignment: .bottom) { Rectangle().fill(ProTheme.seam).frame(height: 1) }
    }
}
public struct ProStatusbar<Content: View>: View {
    let content: Content
    public init(@ViewBuilder content: () -> Content) { self.content = content() }
    public var body: some View {
        HStack(spacing: 14) { content }.padding(.horizontal, 10).frame(maxWidth: .infinity, alignment: .leading).frame(height: 25)
            .font(.system(size: 11, weight: .medium)).foregroundStyle(ProTheme.muted).background(ProTheme.bar)
            .overlay(alignment: .top) { Rectangle().fill(ProTheme.line).frame(height: 1) }
    }
}
public struct ProScopebar<Content: View>: View {
    let content: Content
    public init(@ViewBuilder content: () -> Content) { self.content = content() }
    public var body: some View {
        HStack(spacing: 3) { content }.padding(.horizontal, 10).frame(maxWidth: .infinity, alignment: .leading).frame(height: 36)
            .background(ProTheme.canvas).overlay(alignment: .bottom) { Rectangle().fill(ProTheme.seam).frame(height: 1) }
    }
}
public struct ProScope<Label: View>: View {
    let active: Bool, action: () -> Void, label: Label
    public init(active: Bool = false, action: @escaping () -> Void, @ViewBuilder label: () -> Label) { self.active = active; self.action = action; self.label = label() }
    public var body: some View { Button(action: action) { label }.buttonStyle(ProScopeStyle(active: active)).accessibilityAddTraits(active ? .isSelected : []) }
}
public extension ProScope where Label == Text {
    init(_ title: String, active: Bool = false, action: @escaping () -> Void) { self.init(active: active, action: action) { Text(title) } }
}
private struct ProScopeStyle: ButtonStyle {
    let active: Bool
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        ProScopePaint(configuration: configuration, active: active, enabled: enabled)
    }
}
private struct ProScopePaint: View {
    let configuration: ButtonStyleConfiguration, active: Bool, enabled: Bool
    @State private var hovering = false
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 4, style: .continuous)
        configuration.label.font(.system(size: 11, weight: .medium))
            .foregroundStyle(.white.opacity(active ? 0.95 : hovering ? 0.82 : 0.52))
            .padding(.horizontal, 9).frame(height: 21)
            .background(shape.fill(configuration.isPressed ? Color.black.opacity(0.38) : active ? Color.black.opacity(0.3) : hovering ? Color.white.opacity(0.04) : .clear))
            .modifier(ProRecessedFill(active: active, shape: shape))
            .opacity(enabled ? 1 : 0.4).onHover { hovering = $0 }
            .proDisabledCursor(!enabled)
    }
}
