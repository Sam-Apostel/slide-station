import ProUI
import SlideKit
import SwiftUI

/// The developed slide, rendered off the main thread and cached; keeps showing the last image while
/// a new one renders so slider drags don't flicker.
struct SlideImage: View {
    @Environment(AppModel.self) private var model
    let tray: Tray
    let slide: Slide
    var edge = 1600
    var before = false
    var contentMode: ContentMode = .fit
    @State private var image: UIImage?

    var body: some View {
        let key = PreviewCache.key(slide, edge: edge, before: before)
        ZStack {
            if let image = model.previews.cached(slide, edge: edge, before: before) ?? image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
            } else {
                ProgressView().tint(ProTheme.muted)
            }
        }
        .task(id: key) {
            if model.previews.cached(slide, edge: edge, before: before) != nil { return }
            try? await Task.sleep(for: .milliseconds(40))   // let a slider drag settle
            guard !Task.isCancelled else { return }
            if let img = await model.previews.image(tray, slide, edge: edge, before: before), !Task.isCancelled { image = img }
        }
    }
}

extension SlideStatus {
    var color: Color {
        switch self {
        case .new: ProTheme.dim
        case .reviewed: ProTheme.accent
        case .changed: ProTheme.warn
        case .uploaded: ProTheme.green
        case .skipped: ProTheme.destructive.opacity(0.7)
        }
    }
    var label: String {
        switch self {
        case .new: "New"
        case .reviewed: "Developed"
        case .changed: "Changed since upload"
        case .uploaded: "In Immich"
        case .skipped: "Skipped"
        }
    }
}

/// Big, touch-first buttons for Simple mode (ProUI's controls are sized for a pointer).
struct BigButtonStyle: ButtonStyle {
    var prominent = false
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(prominent ? ProTheme.accentInk : ProTheme.ink)
            .frame(maxWidth: .infinity, minHeight: 56)
            .background(prominent ? ProTheme.accent : Color.white.opacity(0.1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(.black.opacity(0.3), lineWidth: 0.5) }
            .overlay(alignment: .top) {   // the dimple of light the web app's primary buttons have
                RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.white.opacity(prominent ? 0.18 : 0.06)).frame(height: 1).padding(.horizontal, 10)
            }
            .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.4)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.snappy(duration: 0.12), value: configuration.isPressed)
    }
}

/// The job pill: what's running and how far along, with a stop button.
struct JobBanner: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        if let job = model.job {
            HStack(spacing: 12) {
                ProgressView(value: job.total > 0 ? job.fraction : nil).tint(ProTheme.accent).frame(width: 80)
                Text(job.message).font(.system(size: 13, weight: .medium)).lineLimit(1)
                if job.total > 1 { Text("\(job.done) / \(job.total)").font(.system(size: 12).monospacedDigit()).foregroundStyle(ProTheme.muted) }
                Button("Stop") { model.cancelJob() }.font(.system(size: 13, weight: .medium)).foregroundStyle(ProTheme.muted)
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(ProTheme.panel, in: Capsule())
            .overlay { Capsule().strokeBorder(ProTheme.line, lineWidth: 1) }
            .shadow(color: .black.opacity(0.4), radius: 12, y: 4)
            .padding()
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}

/// A slide mount: the thin frame the web app's filmstrip tiles have.
struct Mount<Content: View>: View {
    var selected = false
    @ViewBuilder var content: Content
    var body: some View {
        content
            .padding(5)
            .background(Color(proHex: 0xd8d2c4).opacity(selected ? 0.95 : 0.16), in: RoundedRectangle(cornerRadius: 3, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: 3, style: .continuous).strokeBorder(selected ? ProTheme.accent : .clear, lineWidth: 2) }
    }
}

/// The tray from above: one slot per slide, coloured by status (the web app's `TrayGauge`).
struct TrayGauge: View {
    let statuses: [SlideStatus]
    var current: Int?
    var body: some View {
        GeometryReader { geo in
            let n = max(1, statuses.count)
            let w = geo.size.width / CGFloat(n)
            HStack(spacing: 0) {
                ForEach(Array(statuses.enumerated()), id: \.offset) { i, s in
                    Rectangle().fill(s.color).frame(width: max(1, w - (w > 3 ? 1 : 0)))
                        .overlay { if i == current { Rectangle().fill(.white.opacity(0.9)) } }
                        .frame(width: w)
                }
            }
        }
        .frame(height: 6)
        .background(ProTheme.well)
        .clipShape(RoundedRectangle(cornerRadius: 2))
        .accessibilityElement()
        .accessibilityLabel("Tray progress")
    }
}
