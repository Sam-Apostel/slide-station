import ProUI
import SlideKit
import SwiftUI

/// Slide Station's own skin tokens beyond ProTheme (`frontend/src/theme.css`, `--ss-*`).
enum SS {
    static let panel2 = Color(proHex: 0x1d1d22)      // controls
    static let field = Color(proHex: 0x0c0c0e)
    static let sunken = Color(proHex: 0x0a0a0b)
    static let rail = Color(proHex: 0x111114)
    static let bar = Color(proHex: 0x131316)
    static let accentHover = Color(proHex: 0xf5c26a)
    static let mono = Font.system(size: 10, weight: .bold, design: .monospaced)
}

/// A filmstrip tile is a slide mount (`.ss-mount`): a raised plastic frame, the photo sunk into
/// its window dead centre (3:2 in a square; turned slides keep the square and the window stands
/// up), the number and year printed in the margin, always upright; HDR pressed in above the window. Developed slides are gilded
/// (and stay gold when edited after upload, until that version goes up); slides in Immich are green.
struct MountTile: View {
    let tray: Tray
    let slide: Slide
    let index: Int
    let status: SlideStatus
    let date: SlideDate
    let current: Bool
    var gilding = false

    @State private var sweep: CGFloat = -0.4
    @State private var portrait = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var finish: MountFinish? { status.finish }
    private var finished: Bool { finish != nil }
    /// The finish's colours: gold, or green once Immich has the slide as it is.
    private var metal: MountFinish.Palette { (finish ?? .gold).palette }

    var body: some View {
        GeometryReader { geo in
            let s = geo.size.width
            ZStack {
                window.frame(width: s * (portrait ? 0.55 : 0.82), height: s * (portrait ? 0.82 : 0.55))
                foot(s)
                if slide.activeScans.count > 1 { hdr(s) }
                badges.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing).padding(5)
            }
            .frame(width: s, height: s)
        }
        .aspectRatio(1, contentMode: .fit)
        .background { frame }
        .overlay { if gilding { sweepLight } }
        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        .shadow(color: current && finished ? metal.glow.opacity(0.7) : current ? ProTheme.accent.opacity(0.45) : .clear, radius: 9)
        .shadow(color: .black.opacity(0.55), radius: 4.5, x: 3, y: 4)
        .overlay {
            if current {
                RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(finished ? metal.ring : ProTheme.accent, lineWidth: 1.5)
            }
        }
        .offset(y: current ? -2 : 0)
        .opacity(status == .skipped ? 0.55 : 1)
        .animation(.easeOut(duration: 0.14), value: current)
        .onChange(of: gilding) { _, on in if on { runSweep() } }
        .onAppear { if gilding { runSweep() } }
        .task(id: slide.rotation) { portrait = await isPortrait() }
    }

    // MARK: pieces

    @ViewBuilder private var frame: some View {
        if finished {
            ZStack {
                LinearGradient(stops: metal.stops.map { .init(color: Color(proHex: $0.0), location: $0.1) },
                               startPoint: .topLeading, endPoint: .bottomTrailing)
                BrushedLines().fill(.white.opacity(0.03))
                LinearGradient(colors: [.white.opacity(metal.gloss), .clear], startPoint: .topLeading, endPoint: UnitPoint(x: 0.45, y: 0.45))
            }
            .overlay(alignment: .top) { Rectangle().fill(metal.light.opacity(0.55)).frame(height: 1) }
            .overlay(alignment: .bottom) { Rectangle().fill(metal.shade.opacity(0.6)).frame(height: 1) }
        } else {
            LinearGradient(colors: current ? [Color(proHex: 0x2e2a22), Color(proHex: 0x211e18)] : [Color(proHex: 0x26262c), Color(proHex: 0x1b1b20)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
                .overlay(alignment: .top) { Rectangle().fill(.white.opacity(current ? 0.08 : 0.06)).frame(height: 1) }
                .overlay(alignment: .bottom) { Rectangle().fill(.black.opacity(0.4)).frame(height: 1) }
        }
    }

    private var window: some View {
        SlideImage(tray: tray, slide: slide, edge: 240, contentMode: .fill)
            .grayscale(slide.skip ? 1 : 0).opacity(slide.skip ? 0.25 : 1)
            .clipShape(RoundedRectangle(cornerRadius: 2))
            .background(Color(proHex: 0x050506), in: RoundedRectangle(cornerRadius: 2))
            .overlay { RoundedRectangle(cornerRadius: 2).strokeBorder(.black, lineWidth: 1) }
            // sunk into the mount: dark above, a catch of light below
            .overlay(alignment: .top) { LinearGradient(colors: [.black.opacity(finished ? 0.8 : 0.9), .clear], startPoint: .top, endPoint: .bottom).frame(height: 4).allowsHitTesting(false) }
            .padding(.bottom, 1)
            .background(alignment: .bottom) { Rectangle().fill(finished ? metal.light.opacity(0.45) : .white.opacity(0.07)).frame(height: 1) }
    }

    private var numberColor: Color {
        finished ? metal.print : current ? ProTheme.accent.mix(with: Color(proHex: 0x333333), by: 0.3) : Color(proHex: 0x4c4c55)
    }

    @ViewBuilder private func foot(_ s: CGFloat) -> some View {
        let number = Text(String(format: "%02d", index + 1)).font(SS.mono).tracking(1.4).foregroundStyle(numberColor)
            .shadow(color: finished ? metal.light.opacity(0.45) : .clear, radius: 0, y: 1)
        let year = date.value.isEmpty ? nil : Text("’" + date.value.dropFirst(2).prefix(2))
            .font(.system(size: 9, weight: .bold, design: .monospaced)).tracking(0.5)
            .foregroundStyle(finished ? metal.print : date.source == .own ? Color(proHex: 0x6a6a74) : Color(proHex: 0x45454e))
        if portrait {
            // down the left margin, where the bottom edge ends up after a quarter turn; each mark upright
            VStack(spacing: 0) {
                if !finished { dot }
                Spacer(minLength: 0); number; Spacer(minLength: 0)
                if let year { year }
            }
            .frame(width: s * 0.225, height: s * 0.82).frame(maxWidth: .infinity, alignment: .leading)
        } else {
            ZStack {
                HStack { if !finished { dot }; Spacer() }
                number
                HStack { Spacer(); if let year { year } }
            }
            .frame(width: s * 0.82, height: s * 0.225).frame(maxHeight: .infinity, alignment: .bottom)
        }
    }

    /// HDR, pressed into the margin above the window (`.ss-mount-hdr`): one frame per merged
    /// exposure, fanned out. It belongs to the picture, so on a turned slide it turns with it.
    private func hdr(_ s: CGFloat) -> some View {
        let n = slide.activeScans.count
        return HDRMark(frames: min(n, 4))
            .foregroundStyle(numberColor)
            .shadow(color: finished ? metal.light.opacity(0.45) : .white.opacity(0.07), radius: 0, y: 1)
            .rotationEffect(.degrees(portrait ? 90 : 0))
            .frame(width: portrait ? s * 0.225 : s * 0.82, height: portrait ? s * 0.82 : s * 0.225)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: portrait ? .trailing : .top)
            .accessibilityLabel("HDR ×\(n)")
    }

    private var dot: some View {
        Circle().fill(status.dotFill).frame(width: 8, height: 8)
            .overlay { Circle().strokeBorder(status == .skipped ? Color(proHex: 0x666666) : .black.opacity(0.5), lineWidth: 1.5) }
            .accessibilityLabel(status.label)
    }

    @ViewBuilder private var badges: some View {
        HStack(spacing: 3) {
            if slide.locked != nil { badge { Image(systemName: "lock.fill").font(.system(size: 8, weight: .bold)) } }
        }
    }

    private func badge<C: View>(@ViewBuilder _ c: () -> C) -> some View {
        c().font(.system(size: 9, weight: .semibold)).foregroundStyle(.white.opacity(0.85))
            .padding(.horizontal, 4).frame(height: 15)
            .background(.black.opacity(0.7), in: RoundedRectangle(cornerRadius: 3))
    }

    /// One sweep of light across a slide as it takes on its finish.
    private var sweepLight: some View {
        GeometryReader { g in
            LinearGradient(colors: [.clear, metal.light.opacity(0.7), .clear], startPoint: .leading, endPoint: .trailing)
                .frame(width: g.size.width * 0.35)
                .rotationEffect(.degrees(20))
                .offset(x: g.size.width * sweep)
                .blendMode(.plusLighter)
        }
        .allowsHitTesting(false)
    }

    private func runSweep() {
        guard !reduceMotion else { return }
        sweep = -0.4
        withAnimation(.timingCurve(0.3, 0.1, 0.3, 1, duration: 0.9)) { sweep = 1.1 }
    }

    /// Whether the developed picture stands up (turned slides keep the square mount).
    private func isPortrait() async -> Bool {
        guard let first = slide.activeScans.first else { return false }
        let (t, r) = (tray, slide.rotation)
        let size = await Task.detached { RendererSizes.shared.size(tray: t, scan: first, rotation: r) }.value
        return size.map { $0.height > $0.width } ?? false
    }
}

/// Proxy sizes, read once from the JPEG header.
final class RendererSizes: @unchecked Sendable {
    static let shared = RendererSizes()
    private var cache: [String: CGSize] = [:]
    private let lock = NSLock()
    var library: Library?

    func size(tray: Tray, scan: String, rotation: Int) -> CGSize? {
        let key = "\(tray.id)/\(scan)"
        var s = lock.withLock { cache[key] }
        if s == nil, let library, let url = library.originalURL(tray, scan: scan),
           let src = CGImageSourceCreateWithURL((FileManager.default.fileExists(atPath: url.path) ? url
                : library.cacheDir(tray.id).appendingPathComponent("\(scan).thumb.jpg")) as CFURL, nil),
           let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
           let w = p[kCGImagePropertyPixelWidth] as? CGFloat, let h = p[kCGImagePropertyPixelHeight] as? CGFloat {
            s = CGSize(width: w, height: h)
            lock.withLock { cache[key] = s }
        }
        guard let s else { return nil }
        return rotation % 180 == 0 ? s : CGSize(width: s.height, height: s.width)
    }
}

/// Fine diagonal lines: the brushed-metal grain of a gilded mount.
private struct BrushedLines: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        var x = -r.height
        while x < r.width + r.height {
            p.addRect(CGRect(x: x, y: 0, width: 1, height: r.height * 1.3).applying(CGAffineTransform(a: 1, b: 0, c: -0.18, d: 1, tx: 0, ty: 0)))
            x += 3
        }
        return p
    }
}

/// The HDR mark: stacked exposures, the ones behind showing only the edge the front one leaves.
private struct HDRMark: View {
    let frames: Int

    var body: some View {
        let k = CGFloat(frames)
        ZStack(alignment: .topLeading) {
            ForEach(0..<frames - 1, id: \.self) { i in
                let x = CGFloat(i) * 2.5, y = (k - 1 - CGFloat(i)) * 2
                Path { p in
                    p.move(to: CGPoint(x: x + 2.5, y: y)); p.addLine(to: CGPoint(x: x, y: y))
                    p.addLine(to: CGPoint(x: x, y: y + 7)); p.addLine(to: CGPoint(x: x + 11, y: y + 7))
                    p.addLine(to: CGPoint(x: x + 11, y: y + 5))
                }
                .stroke(style: StrokeStyle(lineWidth: 1.2, lineJoin: .round))
            }
            RoundedRectangle(cornerRadius: 1).frame(width: 11, height: 7).offset(x: (k - 1) * 2.5)
        }
        .frame(width: 11 + (k - 1) * 2.5, height: 7 + (k - 1) * 2, alignment: .topLeading)
    }
}

/// A mount's finish (`FINISH` in filmstrip.tsx): gold once developed, green once in Immich.
enum MountFinish {
    case gold, green

    struct Palette {
        let stops: [(UInt32, CGFloat)]
        var gloss: Double = 0.18
        let light, shade, print, ring, glow: Color
    }

    var palette: Palette {
        switch self {
        case .gold: Palette(stops: [(0xd9ae55, 0), (0xa8792a, 0.35), (0xe6c173, 0.55), (0x8d6220, 1)], light: Color(proHex: 0xfff0c8), shade: Color(proHex: 0x3c2300),
                            print: Color(proHex: 0x5a3c0c), ring: Color(proHex: 0xfff3d0), glow: Color(proHex: 0xf5c86e))
        // polished emerald with its printing inlaid in pale gold
        case .green: Palette(stops: [(0x17b06a, 0), (0x07804a, 0.3), (0x149c5f, 0.5), (0x06703f, 0.68), (0x034428, 1)], gloss: 0.16,
                             light: Color(proHex: 0xc8ffe1), shade: Color(proHex: 0x001e0e),
                             print: Color(proHex: 0xf3d98f), ring: Color(proHex: 0xd6ffe9), glow: Color(proHex: 0x28e68c))
        }
    }
}

extension SlideStatus {
    /// Edited after upload is developed again: gold until that version goes up.
    var finish: MountFinish? {
        switch self {
        case .reviewed, .changed: .gold
        case .uploaded: .green
        case .new, .skipped: nil
        }
    }

    /// The mount's status dot (`STATUS_DOT` in filmstrip.tsx).
    var dotFill: Color {
        switch self {
        case .new: Color(proHex: 0x55555f)
        case .reviewed, .changed: ProTheme.accent
        case .uploaded: ProTheme.green
        case .skipped: .clear
        }
    }
}

extension Color {
    func mix(with other: Color, by amount: Double) -> Color {
        let a = UIColor(self), b = UIColor(other)
        var (r1, g1, b1, a1): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        var (r2, g2, b2, a2): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        a.getRed(&r1, green: &g1, blue: &b1, alpha: &a1); b.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
        let t = CGFloat(amount)
        return Color(red: r1 + (r2 - r1) * t, green: g1 + (g2 - g1) * t, blue: b1 + (b2 - b1) * t)
    }
}

/// The tray from above: slides on edge in a sunken channel, coloured by status, the current one
/// standing tall and white (`.ss-tray`).
struct TraySlots: View {
    let statuses: [SlideStatus]
    /// Slots in the tray (its box's: 50, or 36): the empty ones show too. nil = just the slides.
    var size: Int?
    var current: Int?
    var onSelect: ((Int) -> Void)?

    var body: some View {
        HStack(alignment: .bottom, spacing: 1) {
            ForEach(Array(statuses.enumerated()), id: \.offset) { i, s in
                let isCurrent = i == current
                RoundedRectangle(cornerRadius: 1)
                    .fill(isCurrent ? AnyShapeStyle(LinearGradient(colors: [.white, Color(proHex: 0xcfcac0)], startPoint: .leading, endPoint: .trailing)) : s.slotFill)
                    .overlay(alignment: .leading) { if !isCurrent && s != .skipped { Rectangle().fill(.white.opacity(0.08)).frame(width: 1) } }
                    .frame(maxWidth: 9, minHeight: 1)
                    .frame(height: isCurrent ? 24 : s == .skipped ? 8 : 16)
                    .shadow(color: isCurrent ? .white.opacity(0.35) : .clear, radius: 4)
                    .contentShape(Rectangle())
                    .onTapGesture { onSelect?(i) }
            }
            // a slot with no slide in it: the tray's floor between the ridges
            ForEach(0..<max(0, (size ?? 0) - statuses.count), id: \.self) { _ in
                RoundedRectangle(cornerRadius: 1).fill(.white.opacity(0.07))
                    .frame(maxWidth: 9, minHeight: 1).frame(height: 2)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 5).padding(.top, 4)
        .frame(height: 26, alignment: .bottom)
        .background(LinearGradient(colors: [Color(proHex: 0x0a0a0c), Color(proHex: 0x121216)], startPoint: .top, endPoint: .bottom), in: RoundedRectangle(cornerRadius: 5))
        .overlay { RoundedRectangle(cornerRadius: 5).stroke(.black.opacity(0.7), lineWidth: 1).blur(radius: 1.5).mask(RoundedRectangle(cornerRadius: 5)) }
        .overlay(alignment: .bottom) { Rectangle().fill(.white.opacity(0.04)).frame(height: 1).offset(y: 1) }
        .animation(.easeOut(duration: 0.12), value: current)
        .accessibilityElement().accessibilityLabel("Tray: \(statuses.filter { $0.finish != nil }.count) of \(statuses.count) done")
    }
}

extension SlideStatus {
    var slotFill: AnyShapeStyle {
        func g(_ a: UInt32, _ b: UInt32) -> AnyShapeStyle { AnyShapeStyle(LinearGradient(colors: [Color(proHex: a), Color(proHex: b)], startPoint: .leading, endPoint: .trailing)) }
        switch self {
        case .new: return g(0x3b3b44, 0x2c2c33)
        case .reviewed: return g(0xf5c26a, 0xc98d2c)
        case .uploaded: return g(0x3ee39a, 0x07804a)
        case .changed: return g(0xf5c26a, 0xc98d2c)  // developed again, gold like its mount
        case .skipped: return AnyShapeStyle(Color(proHex: 0x1e1e23))
        }
    }
}
