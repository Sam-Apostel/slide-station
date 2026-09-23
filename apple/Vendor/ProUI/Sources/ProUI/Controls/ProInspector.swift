import SwiftUI

public struct ProInspector<Content: View>: View {
    let width: CGFloat, content: Content
    public init(width: CGFloat = 280, @ViewBuilder content: () -> Content) { self.width = width; self.content = content() }
    public var body: some View { VStack(spacing: 0) { content }.frame(width: width).frame(maxHeight: .infinity, alignment: .top).background(ProTheme.canvas).font(.system(size: 12)) }
}
public struct ProDisclosureGroup<Content: View>: View {
    let title: String, summary: String?, right: AnyView?, content: Content, controlled: Binding<Bool>?, showsBottomSeparator: Bool
    @State private var internalExpanded: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    public init(title: String, summary: String? = nil, defaultExpanded: Bool = true, showsBottomSeparator: Bool = true, @ViewBuilder content: () -> Content) {
        self.title = title; self.summary = summary; right = nil; controlled = nil; self.showsBottomSeparator = showsBottomSeparator; _internalExpanded = State(initialValue: defaultExpanded); self.content = content()
    }
    public init(title: String, expanded: Binding<Bool>, summary: String? = nil, showsBottomSeparator: Bool = true, @ViewBuilder content: () -> Content) {
        self.title = title; self.summary = summary; right = nil; controlled = expanded; self.showsBottomSeparator = showsBottomSeparator; _internalExpanded = State(initialValue: expanded.wrappedValue); self.content = content()
    }
    public init<Right: View>(title: String, summary: String? = nil, defaultExpanded: Bool = true, showsBottomSeparator: Bool = true, @ViewBuilder right: () -> Right, @ViewBuilder content: () -> Content) {
        self.title = title; self.summary = summary; self.right = AnyView(right()); controlled = nil; self.showsBottomSeparator = showsBottomSeparator; _internalExpanded = State(initialValue: defaultExpanded); self.content = content()
    }
    public init<Right: View>(title: String, expanded: Binding<Bool>, summary: String? = nil, showsBottomSeparator: Bool = true, @ViewBuilder right: () -> Right, @ViewBuilder content: () -> Content) {
        self.title = title; self.summary = summary; self.right = AnyView(right()); controlled = expanded; self.showsBottomSeparator = showsBottomSeparator; _internalExpanded = State(initialValue: expanded.wrappedValue); self.content = content()
    }
    private var expanded: Bool { controlled?.wrappedValue ?? internalExpanded }
    private func toggle() {
        if let controlled { controlled.wrappedValue.toggle() } else { internalExpanded.toggle() }
    }
    public var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                Button(action: toggle) {
                    HStack(spacing: 7) {
                        ProDisclosureChevron().stroke(style: StrokeStyle(lineWidth: 1.25, lineCap: .round, lineJoin: .round)).frame(width: 10, height: 10)
                            .rotationEffect(.degrees(expanded ? 0 : -90)).animation(reduceMotion ? nil : .smooth(duration: 0.075), value: expanded)
                        Text(title).lineLimit(1)
                        Spacer(minLength: 0)
                        if !expanded, let summary { Text(summary).font(.system(size: 10, weight: .medium)).foregroundStyle(.white.opacity(0.4)) }
                    }.padding(.horizontal, 10).frame(height: 34).contentShape(Rectangle())
                }.buttonStyle(.plain).font(.system(size: 11, weight: .medium)).foregroundStyle(.white.opacity(0.85)).accessibilityValue(expanded ? "Expanded" : "Collapsed")
                if let right { HStack(spacing: 4) { right }.frame(height: 34).padding(.trailing, 10).foregroundStyle(.white.opacity(0.5)).buttonStyle(ProInspectorActionButtonStyle()) }
            }.background(ProTheme.panel)
                .overlay(alignment: .top) { Rectangle().fill(ProTheme.seam).frame(height: 1) }
                // An expanded header always closes with a seam, including the
                // last group in a stack — `showsBottomSeparator` only governs
                // the run of groups, never the header's own bottom edge.
                .overlay(alignment: .bottom) { if expanded { Rectangle().fill(ProTheme.seam).frame(height: 1) } }
            if expanded { VStack(spacing: 0) { content }.frame(maxWidth: .infinity) }
        }.background(ProTheme.canvas).clipped()
    }
}
private struct ProDisclosureChevron: Shape {
    func path(in rect: CGRect) -> Path {
        Path { path in
            path.move(to: CGPoint(x: rect.minX + rect.width * 0.2, y: rect.minY + rect.height * 0.38))
            path.addLine(to: CGPoint(x: rect.midX, y: rect.minY + rect.height * 0.68))
            path.addLine(to: CGPoint(x: rect.maxX - rect.width * 0.2, y: rect.minY + rect.height * 0.38))
        }
    }
}
private struct ProInspectorActionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { ProInspectorActionButtonPaint(configuration: configuration) }
}
private struct ProInspectorActionButtonPaint: View {
    let configuration: ButtonStyleConfiguration
    @State private var hovering = false
    @Environment(\.isEnabled) private var enabled
    var body: some View {
        configuration.label.frame(width: 22, height: 22)
            .background(configuration.isPressed ? Color.white.opacity(0.08) : hovering ? Color.white.opacity(0.06) : .clear, in: RoundedRectangle(cornerRadius: 3, style: .continuous))
            .foregroundStyle(hovering ? Color.white.opacity(0.85) : Color.white.opacity(0.5))
            .contentShape(Rectangle()).onHover { hovering = $0 }
            .proDisabledCursor(!enabled)
    }
}
public typealias ProDisclosure<Content: View> = ProDisclosureGroup<Content>
