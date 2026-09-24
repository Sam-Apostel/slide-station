import ProUI
import SlideKit
import SwiftUI

/// Point curve editor (`components/tone-curve.tsx`): RGB plus one curve per colour channel, drawn
/// over the histogram of what it works on. Tap to add a point, drag to move, double-tap or drag an
/// inner point out of the box to remove it. "Fit to data" pulls each channel's ends in to where the
/// scan's data sits — the classic fix for faded slides. The spline is SlideKit's `Curves.lut`, so
/// what is drawn is what gets rendered.
struct ToneCurveView: View {
    @Environment(AppModel.self) private var model
    let slide: Slide
    let histogram: [String: [Int]]
    @AppStorage("curveChannel") private var channel = "rgb"
    @State private var drag: (index: Int, removing: Bool)?
    @State private var hover: Int?

    static let ink: [String: Color] = ["rgb": ProTheme.ink, "r": Color(proHex: 0xe5655b), "g": Color(proHex: 0x5fc27a), "b": Color(proHex: 0x5b8fe8)]
    static let label = ["rgb": "RGB", "r": "Red", "g": "Green", "b": "Blue"]
    static let minGap = 0.01
    static let removeBeyond = 0.12

    private var curves: [String: [[Double]]] { slide.params.curves }
    private var points: [[Double]] { curves[channel] ?? [[0, 0], [1, 1]] }

    static func note(_ curves: [String: [[Double]]]) -> String {
        let edited = Curves.channels.filter { curves[$0] != nil }
        return edited.isEmpty ? "straight" : edited.map { $0 == "rgb" ? "RGB" : $0.uppercased() }.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 4) {
                ForEach(Curves.channels, id: \.self) { c in
                    Button { channel = c } label: {
                        HStack(spacing: 6) {
                            Circle().fill(c == "rgb" ? AnyShapeStyle(AngularGradient(colors: [Self.ink["r"]!, Self.ink["g"]!, Self.ink["b"]!, Self.ink["r"]!], center: .center)) : AnyShapeStyle(Self.ink[c]!))
                                .frame(width: 9, height: 9)
                            Text(c == "rgb" ? "RGB" : c.uppercased()).font(.system(size: 11, weight: .medium))
                        }
                        .padding(.horizontal, 8).frame(height: 24)
                        .foregroundStyle(channel == c ? ProTheme.ink : ProTheme.muted)
                        .background(channel == c ? SS.panel2 : .clear, in: RoundedRectangle(cornerRadius: 5))
                        .overlay { if channel == c { RoundedRectangle(cornerRadius: 5).strokeBorder(Color(proHex: 0x45454f), lineWidth: 1) } }
                        .overlay(alignment: .topTrailing) { if curves[c] != nil { Circle().fill(ProTheme.accent).frame(width: 4, height: 4).padding(3) } }
                    }
                    .buttonStyle(.plain).accessibilityLabel("\(Self.label[c]!) curve").accessibilityAddTraits(channel == c ? .isSelected : [])
                }
                Spacer()
                if let i = drag?.index ?? hover, points.indices.contains(i) {
                    Text("\(Int((points[i][0] * 255).rounded())) → \(Int((points[i][1] * 255).rounded()))")
                        .font(.system(size: 10, design: .monospaced)).monospacedDigit().foregroundStyle(ProTheme.muted)
                }
            }
            GeometryReader { geo in
                let size = geo.size.width
                canvas(size)
                    .contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .local)
                        .onChanged { g in dragChanged(g, size: size) }
                        .onEnded { _ in dragEnded() })
                    .simultaneousGesture(SpatialTapGesture(count: 2).onEnded { g in doubleTap(unit(g.location, size), size: size) })
            }
            .aspectRatio(1, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .accessibilityLabel("\(Self.label[channel]!) tone curve")

            HStack(spacing: 6) {
                ProButton(action: { model.fitCurves() }) { Label("Fit to data", systemImage: "wand.and.stars") }
                ProButton("Fit all", action: { model.fitCurves(all: true) })
                Spacer()
                ProButton(plain: true, action: { commit(nil) }) { Image(systemName: "arrow.uturn.backward") }
                    .disabled(curves[channel] == nil).accessibilityLabel("Reset \(Self.label[channel]!) curve")
            }
        }
    }

    // MARK: drawing

    private func canvas(_ size: CGFloat) -> some View {
        Canvas { ctx, sz in
            let s = sz.width
            ctx.fill(Path(CGRect(origin: .zero, size: sz)), with: .color(SS.sunken))
            // histogram of the curve's input (sqrt, end bins ignored for the scale)
            let hists = channel == "rgb" ? ["r", "g", "b"] : [channel]
            for c in hists { if let bins = histogram[c] { ctx.fill(histPath(bins, s), with: .color(Self.ink[c]!.opacity(channel == "rgb" ? 0.3 : 0.32))) } }
            // quarter grid + the straight line
            for t in [0.25, 0.5, 0.75] {
                ctx.stroke(Path { p in p.move(to: CGPoint(x: t * s, y: 0)); p.addLine(to: CGPoint(x: t * s, y: s)) }, with: .color(ProTheme.line), lineWidth: 1)
                ctx.stroke(Path { p in p.move(to: CGPoint(x: 0, y: t * s)); p.addLine(to: CGPoint(x: s, y: t * s)) }, with: .color(ProTheme.line), lineWidth: 1)
            }
            ctx.stroke(Path { p in p.move(to: CGPoint(x: 0, y: s)); p.addLine(to: CGPoint(x: s, y: 0)) }, with: .color(ProTheme.dim), style: StrokeStyle(lineWidth: 1, dash: [3, 4]))
            // the other edited channels, faintly
            for c in Curves.channels where c != channel { if let pts = curves[c] { ctx.stroke(curvePath(pts, s), with: .color(Self.ink[c]!.opacity(0.35)), lineWidth: 1.25) } }
            // clipped ranges outside the end points
            let pts = points
            ctx.fill(Path(CGRect(x: 0, y: 0, width: pts[0][0] * s, height: s)), with: .color(.black.opacity(0.35)))
            ctx.fill(Path(CGRect(x: pts[pts.count - 1][0] * s, y: 0, width: (1 - pts[pts.count - 1][0]) * s, height: s)), with: .color(.black.opacity(0.35)))
            ctx.stroke(curvePath(pts, s), with: .color(Self.ink[channel]!), lineWidth: 1.75)
            for (i, p) in pts.enumerated() {
                let r: CGFloat = i == (drag?.index ?? hover) ? 6 : 5
                let rect = CGRect(x: p[0] * s - r, y: (1 - p[1]) * s - r, width: r * 2, height: r * 2)
                let removing = drag?.index == i && drag?.removing == true
                ctx.fill(Path(ellipseIn: rect), with: .color(drag?.index == i ? Self.ink[channel]! : SS.sunken))
                ctx.stroke(Path(ellipseIn: rect), with: .color(Self.ink[channel]!.opacity(removing ? 0.3 : 1)), lineWidth: 1.5)
            }
        }
    }

    private func histPath(_ bins: [Int], _ s: CGFloat) -> Path {
        let peak = sqrt(Double(max(1, bins.dropFirst().dropLast().max() ?? 1)))
        let w = s / CGFloat(bins.count)
        var p = Path()
        p.move(to: CGPoint(x: 0, y: s))
        for (i, v) in bins.enumerated() {
            let y = s - CGFloat(min(1, sqrt(Double(v)) / peak)) * s * 0.92
            p.addLine(to: CGPoint(x: CGFloat(i) * w, y: y)); p.addLine(to: CGPoint(x: CGFloat(i + 1) * w, y: y))
        }
        p.addLine(to: CGPoint(x: s, y: s)); p.closeSubpath()
        return p
    }

    private func curvePath(_ pts: [[Double]], _ s: CGFloat) -> Path {
        let lut = Curves.lut(pts, n: 129)
        var p = Path()
        for (i, v) in lut.enumerated() {
            let pt = CGPoint(x: CGFloat(i) / 128 * s, y: (1 - CGFloat(v)) * s)
            if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
        }
        return p
    }

    // MARK: editing

    private func unit(_ p: CGPoint, _ s: CGFloat) -> [Double] { [Double(p.x / s), Double(1 - p.y / s)] }

    /// Touch targets are bigger than on the web: a finger, not a pointer.
    private func nearest(_ u: [Double], in list: [[Double]], size: CGFloat) -> Int? {
        var best: Int?, dist = 22.0
        for (i, p) in list.enumerated() {
            let d = hypot((p[0] - u[0]) * size, (p[1] - u[1]) * size)
            if d <= dist { best = i; dist = d }
        }
        return best
    }

    /// Where point i may go: between its neighbours, inside the box.
    private func place(_ list: [[Double]], _ i: Int, _ u: [Double]) -> [Double] {
        let lo = i == 0 ? 0 : list[i - 1][0] + Self.minGap
        let hi = i == list.count - 1 ? 1 : list[i + 1][0] - Self.minGap
        let r = { (v: Double) in (v * 1000).rounded() / 1000 }
        return [r(min(hi, max(lo, u[0]))), r(min(1, max(0, u[1])))]
    }

    private func commit(_ list: [[Double]]?) {
        var c = curves
        if let list, list != [[0, 0], [1, 1]] { c[channel] = list } else { c[channel] = nil }
        model.setCurves(c)
    }

    private func dragChanged(_ g: DragGesture.Value, size: CGFloat) {
        let u = unit(g.location, size)
        var list = points
        if drag == nil {
            let start = unit(g.startLocation, size)
            if let i = nearest(start, in: list, size: size) { drag = (i, false); hover = i }
            else {
                // a new point on the touch's input value, at the touch's height
                guard list.count < 16, let at = list.firstIndex(where: { $0[0] > start[0] }), at > 0,
                      start[0] - list[at - 1][0] >= Self.minGap, list[at][0] - start[0] >= Self.minGap else { return }
                list.insert(place(list, at, start), at: at)
                drag = (at, false)
                commit(list)
                return
            }
        }
        guard var d = drag, list.indices.contains(d.index) else { return }
        let inner = d.index > 0 && d.index < list.count - 1
        let out = max(-u[0], u[0] - 1, -u[1], u[1] - 1)
        d.removing = inner && out > Self.removeBeyond
        drag = d
        if d.removing { return }
        list[d.index] = place(list, d.index, u)
        commit(list)
    }

    private func dragEnded() {
        if let d = drag, d.removing { var list = points; list.remove(at: d.index); commit(list) }
        drag = nil
        hover = nil
    }

    private func doubleTap(_ u: [Double], size: CGFloat) {
        let pts = points
        guard let i = nearest(u, in: pts, size: size) else { return }
        var list = pts
        if i == 0 { list[0] = [0, 0] } else if i == pts.count - 1 { list[i] = [1, 1] } else { list.remove(at: i) }
        commit(list)
    }
}
