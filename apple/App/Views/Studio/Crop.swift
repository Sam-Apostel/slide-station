import ProUI
import SlideKit
import SwiftUI

/// Crop & straighten (`components/crop.tsx`). The frame is 0…1 of the straightened photo, as
/// SlideKit crops it; the overlay sits on the uncropped preview.
enum CropMath {
    typealias Rect = [Double]   // l, t, r, b
    static let full: Rect = [0, 0, 1, 1]
    static let minSize = 0.05

    static let aspects: [(String, Double?)] = [("Free", nil), ("Original", -1), ("3:2", 1.5), ("4:3", 4.0 / 3), ("5:4", 1.25), ("1:1", 1), ("16:9", 16.0 / 9)]

    /// Apply an aspect (width / height in pixels) keeping the rect centred and inside the photo.
    static func fit(_ r: Rect, ratio: Double, frame: Double) -> Rect {
        let cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2
        var w = r[2] - r[0], h = w * frame / ratio
        if h > r[3] - r[1] { h = r[3] - r[1]; w = h * ratio / frame }
        if w > 1 { w = 1; h = frame / ratio }
        if h > 1 { h = 1; w = ratio / frame }
        let l = min(max(cx - w / 2, 0), 1 - w), t = min(max(cy - h / 2, 0), 1 - h)
        return [l, t, l + w, t + h]
    }

    enum Handle: CaseIterable { case nw, n, ne, e, se, s, sw, w, move }

    /// A drag on a handle. With a ratio, an edge that reaches the photo's border keeps sliding
    /// along it (the size gives way) instead of stopping — the web tool's open polish item.
    static func drag(_ h: Handle, from start: Rect, dx: Double, dy: Double, ratio: Double?, frame: Double) -> Rect {
        var (l, t, r, b) = (start[0], start[1], start[2], start[3])
        if h == .move {
            let w = r - l, hh = b - t
            l = min(max(l + dx, 0), 1 - w); t = min(max(t + dy, 0), 1 - hh)
            return [l, t, l + w, t + hh]
        }
        let west = [.nw, .w, .sw].contains(h), east = [.ne, .e, .se].contains(h)
        let north = [.nw, .n, .ne].contains(h), south = [.sw, .s, .se].contains(h)
        if west { l = min(max(l + dx, 0), r - minSize) }
        if east { r = max(min(r + dx, 1), l + minSize) }
        if north { t = min(max(t + dy, 0), b - minSize) }
        if south { b = max(min(b + dy, 1), t + minSize) }
        guard let ratio else { return [l, t, r, b] }
        if h == .n || h == .s {
            // height leads; width follows around the centre, within the photo
            var hh = b - t, w = hh * ratio / frame
            if w > 1 { w = 1; hh = frame / ratio; if h == .n { t = b - hh } else { b = t + hh } }
            let cx = (start[0] + start[2]) / 2
            l = min(max(cx - w / 2, 0), 1 - w); r = l + w
        } else {
            // width leads; height follows from the fixed edge, shrinking where the photo ends
            var w = r - l, hh = w * frame / ratio
            let room: Double
            if north { room = b } else if south { room = 1 - t } else { room = 1 }
            if hh > room { hh = room; w = hh * ratio / frame; if west { l = r - w } else { r = l + w } }
            if north { t = b - hh } else if south { b = t + hh } else {
                let cy = (start[1] + start[3]) / 2
                t = min(max(cy - hh / 2, 0), 1 - hh); b = t + hh
            }
        }
        return [l, t, r, b]
    }
}

/// The frame over the photo: dimmed outside, thirds while dragging, eight handles.
struct CropOverlay: View {
    @Binding var rect: CropMath.Rect
    let ratio: Double?
    let frame: Double   // the photo's pixel aspect (w / h)
    @State private var start: CropMath.Rect?
    @State private var handle: CropMath.Handle?

    var body: some View {
        GeometryReader { geo in
            let W = geo.size.width, H = geo.size.height
            let box = CGRect(x: rect[0] * W, y: rect[1] * H, width: (rect[2] - rect[0]) * W, height: (rect[3] - rect[1]) * H)
            ZStack(alignment: .topLeading) {
                Path { p in p.addRect(CGRect(x: 0, y: 0, width: W, height: H)); p.addRect(box) }
                    .fill(Color(proHex: 0x08080a).opacity(0.68), style: FillStyle(eoFill: true))
                Rectangle().strokeBorder(.white.opacity(0.85), lineWidth: 1).frame(width: box.width, height: box.height).offset(x: box.minX, y: box.minY)
                if handle != nil {
                    Path { p in
                        for k in [1.0, 2.0] {
                            p.move(to: CGPoint(x: box.minX + box.width * k / 3, y: box.minY)); p.addLine(to: CGPoint(x: box.minX + box.width * k / 3, y: box.maxY))
                            p.move(to: CGPoint(x: box.minX, y: box.minY + box.height * k / 3)); p.addLine(to: CGPoint(x: box.maxX, y: box.minY + box.height * k / 3))
                        }
                    }.stroke(.white.opacity(0.22), lineWidth: 1)
                    Text("\(Int(((rect[2] - rect[0]) * 100).rounded())) × \(Int(((rect[3] - rect[1]) * 100).rounded())) %")
                        .font(.system(size: 10, design: .monospaced)).foregroundStyle(.white.opacity(0.8))
                        .padding(.horizontal, 6).padding(.vertical, 1).background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 4))
                        .position(x: box.maxX - 40, y: box.maxY - 14)
                }
                ForEach(CropMath.Handle.allCases.filter { $0 != .move }, id: \.self) { h in
                    handleMark(h).position(point(h, box))
                }
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 1).onChanged { g in
                if start == nil {
                    start = rect
                    handle = CropMath.Handle.allCases.filter { $0 != .move }.min { hypot(point($0, box).x - g.startLocation.x, point($0, box).y - g.startLocation.y) < hypot(point($1, box).x - g.startLocation.x, point($1, box).y - g.startLocation.y) }
                        .flatMap { hypot(point($0, box).x - g.startLocation.x, point($0, box).y - g.startLocation.y) < 28 ? $0 : nil }
                        ?? (box.contains(g.startLocation) ? .move : nil)
                }
                guard let s = start, let h = handle else { return }
                rect = CropMath.drag(h, from: s, dx: g.translation.width / W, dy: g.translation.height / H, ratio: ratio, frame: frame)
            }.onEnded { _ in start = nil; handle = nil })
        }
    }

    private func point(_ h: CropMath.Handle, _ b: CGRect) -> CGPoint {
        switch h {
        case .nw: CGPoint(x: b.minX, y: b.minY)
        case .n: CGPoint(x: b.midX, y: b.minY)
        case .ne: CGPoint(x: b.maxX, y: b.minY)
        case .e: CGPoint(x: b.maxX, y: b.midY)
        case .se: CGPoint(x: b.maxX, y: b.maxY)
        case .s: CGPoint(x: b.midX, y: b.maxY)
        case .sw: CGPoint(x: b.minX, y: b.maxY)
        case .w: CGPoint(x: b.minX, y: b.midY)
        case .move: CGPoint(x: b.midX, y: b.midY)
        }
    }

    private func handleMark(_ h: CropMath.Handle) -> some View {
        let side = h == .n || h == .s ? CGSize(width: 16, height: 4) : h == .e || h == .w ? CGSize(width: 4, height: 16) : CGSize(width: 9, height: 9)
        return RoundedRectangle(cornerRadius: 2).fill(.white).frame(width: side.width, height: side.height).shadow(color: .black.opacity(0.8), radius: 2, y: 1)
    }
}

/// The crop tool's controls, in place of the scan strip while cropping (`.ss-cropbar`).
struct CropBar: View {
    @Binding var rect: CropMath.Rect
    @Binding var aspect: String
    @Binding var ratio: Double?
    @Binding var portrait: Bool
    let frame: Double
    let angle: Double
    let onAngle: (Double) -> Void
    let onCancel: () -> Void
    let onDone: () -> Void

    private var straighten: some View {
        HStack(spacing: 10) {
            Text("Straighten").foregroundStyle(ProTheme.muted).fixedSize()
            Slider(value: Binding(get: { angle }, set: { onAngle(($0 * 10).rounded() / 10) }), in: -15...15).frame(width: 180)
            Text(String(format: "%+.1f°", angle)).font(.system(size: 11, design: .monospaced)).fixedSize()
                .onTapGesture(count: 2) { onAngle(0) }
        }
    }

    private var actions: some View {
        HStack(spacing: 8) {
            ProButton(plain: true, action: { rect = CropMath.full; onAngle(0) }) { Label("Reset", systemImage: "arrow.counterclockwise").fixedSize() }
            ProButton(action: onCancel) { Label("Cancel", systemImage: "xmark").fixedSize() }
            ProButton(active: true, action: onDone) { Label("Done", systemImage: "checkmark").fixedSize() }
        }
    }

    var body: some View {
        // two rows, like the web bar wraps: aspect presets, then straighten and the actions
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                HStack(spacing: 0) {
                    ForEach(CropMath.aspects, id: \.0) { name, v in
                        Button {
                            aspect = name
                            var r = v == -1 ? frame : v
                            if let x = r, portrait, v != -1 { r = 1 / x }
                            ratio = r
                            if let r { rect = CropMath.fit(rect, ratio: r, frame: frame) }
                        } label: {
                            Text(name).font(.system(size: 11, weight: .medium)).fixedSize().padding(.horizontal, 8).frame(height: 26)
                                .foregroundStyle(aspect == name ? ProTheme.ink : ProTheme.muted)
                                .background(aspect == name ? SS.panel2 : .clear, in: RoundedRectangle(cornerRadius: 5))
                                .contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityAddTraits(aspect == name ? .isSelected : [])
                    }
                }
                .padding(2).background(SS.field, in: RoundedRectangle(cornerRadius: 7))
                ProButton(plain: true, action: {
                    portrait.toggle()
                    if let r = ratio, aspect != "Original" { ratio = 1 / r; rect = CropMath.fit(rect, ratio: 1 / r, frame: frame) }
                }) { Image(systemName: "rectangle.portrait.rotate") }
                    .disabled(aspect == "Free" || aspect == "1:1").accessibilityLabel("Swap portrait and landscape")
                Spacer(minLength: 0)
            }
            // straighten and the actions share a row when the stage is wide (landscape), not in portrait
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { straighten; Spacer(minLength: 0); actions }
                VStack(alignment: .leading, spacing: 10) { straighten; HStack { Spacer(minLength: 0); actions } }
            }
        }
        .font(.system(size: 12))
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(SS.bar)
        .overlay(alignment: .top) { Rectangle().fill(ProTheme.line).frame(height: 1) }
    }
}
