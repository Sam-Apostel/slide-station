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
