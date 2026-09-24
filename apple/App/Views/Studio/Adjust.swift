import ProUI
import SlideKit
import SwiftUI

/// The Adjust panel (`components/adjust.tsx`): Restore, Light and Colour, each control showing
/// what it does (painted rails, a white-balance pad) and what has been touched (amber marks).
struct AdjustPanel: View {
    @Environment(AppModel.self) private var model
    let tray: Tray
    let slide: Slide
    @Binding var picking: Bool

    private func off(_ v: Double, _ d: Double = 0) -> Bool { abs(v - d) > 0.004 }

    var body: some View {
        let p = slide.params, d = tray.defaults
        let curvesOn = !p.curves.isEmpty
        VStack(spacing: 0) {
            AdjGroup(title: "Restore", note: curvesOn && p.strength == 0 ? "by the tone curve" : nil,
                     changed: off(p.strength, d.strength) || p.trim != d.trim || off(p.dust, d.dust),
                     reset: { model.resetParams([\.strength, \.dust], trim: true) }) {
                AdjSlider(spec: .strength, value: p.strength, reset: d.strength) { model.setParam(\.strength, $0, name: "strength") }
                AdjSlider(spec: .dust, value: p.dust, reset: d.dust) { model.setParam(\.dust, $0, name: "dust") }
                Button { model.setTrim(!p.trim) } label: {
                    HStack(spacing: 8) {
                        RoundedRectangle(cornerRadius: 4).fill(p.trim ? ProTheme.accent : SS.field)
                            .overlay { if p.trim { Image(systemName: "checkmark").font(.system(size: 9, weight: .heavy)).foregroundStyle(ProTheme.accentInk) } }
                            .overlay { RoundedRectangle(cornerRadius: 4).strokeBorder(p.trim ? .clear : ProTheme.line, lineWidth: 1) }
                            .frame(width: 16, height: 16)
                        Text("Trim dark mount edges").font(.system(size: 12)).foregroundStyle(ProTheme.muted)
                        Spacer()
                    }.contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityAddTraits(p.trim ? .isSelected : [])
            }
            AdjGroup(title: "Light", changed: off(p.brightness) || off(p.contrast),
                     reset: { model.resetParams([\.brightness, \.contrast]) }) {
                AdjSlider(spec: .brightness, value: p.brightness) { model.setParam(\.brightness, $0, name: "brightness") }
                AdjSlider(spec: .contrast, value: p.contrast) { model.setParam(\.contrast, $0, name: "contrast") }
            }
            AdjGroup(title: "Colour", changed: off(p.warmth) || off(p.tint) || off(p.saturation),
                     reset: { model.resetParams([\.warmth, \.tint, \.saturation]) }) {
                BalancePad(warmth: p.warmth, tint: p.tint, picking: $picking) { model.setBalance(warmth: $0, tint: $1) }
                AdjSlider(spec: .saturation, value: p.saturation) { model.setParam(\.saturation, $0, name: "saturation") }
            }
        }
        .padding(.bottom, 4)
    }

    /// "learned from 7 · 2 changed" — the collapsed Adjust section's summary.
    static func summary(_ g: Slide, defaults d: Params) -> String {
        let p = g.params
        let off = { (v: Double, x: Double) in abs(v - x) > 0.004 }
        let n = [off(p.brightness, 0), off(p.contrast, 0), off(p.saturation, 0), off(p.warmth, 0) || off(p.tint, 0), off(p.strength, d.strength), off(p.dust, 0)].filter { $0 }.count
        let src = g.paramsSource.map { $0.hasPrefix("learned:") ? "learned from \($0.dropFirst(8))" : $0 == "manual" ? "by hand" : "tray defaults" } ?? "tray defaults"
        return n > 0 ? "\(src) · \(n) changed" : src
    }
}

/// A group of adjustments with a small uppercase heading and its own reset (`.ss-adj-group`).
struct AdjGroup<Content: View>: View {
    let title: String
    var note: String?
    let changed: Bool
    let reset: () -> Void
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(title.uppercased()).font(.system(size: 10, weight: .semibold)).tracking(1.2).foregroundStyle(ProTheme.dim)
                if let note { Text(note).font(.system(size: 10)).foregroundStyle(ProTheme.dim) }
                Spacer()
                if changed {
                    Button(action: reset) { Image(systemName: "arrow.uturn.backward").font(.system(size: 10, weight: .semibold)).frame(width: 18, height: 18) }
                        .buttonStyle(.plain).foregroundStyle(ProTheme.muted).accessibilityLabel("Reset \(title.lowercased())")
                }
            }
            .frame(height: 16)
            content
        }
        .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 12)
        .overlay(alignment: .top) { Rectangle().fill(ProTheme.lineSoft).frame(height: 1) }
    }
}

/// What a slider does, painted on its rail (SPECS in adjust.tsx).
struct AdjSpec {
    var label: String
    var range: ClosedRange<Double>
    var rail: [Gradient.Stop]
    var split: [Gradient.Stop]?   // contrast: top half light, bottom half dark
    var bipolar: Bool { range.lowerBound < 0 }

    static func stops(_ list: [(UInt32, Double)]) -> [Gradient.Stop] { list.map { .init(color: Color(proHex: $0.0), location: $0.1) } }
    static let strength = AdjSpec(label: "Auto restore", range: 0...1, rail: stops([(0x6d7876, 0), (0x8c8a78, 0.45), (0xd49a48, 1)]))
    /// dust & scratch repair: specks on the left, clean to the right
    static let dust = AdjSpec(label: "Dust", range: 0...1, rail: stops([(0x3a3c3b, 0), (0x5f6361, 0.12), (0x6f7371, 0.5), (0x8a8d8b, 1)]))
    static let brightness = AdjSpec(label: "Brightness", range: -1...1, rail: stops([(0x0d0d0f, 0), (0x6a6a6a, 0.5), (0xf1efe9, 1)]))
    static let contrast = AdjSpec(label: "Contrast", range: -1...1, rail: stops([(0x707070, 0), (0xe8e8e8, 1)]), split: stops([(0x5c5c5c, 0), (0x0b0b0b, 1)]))
    static let saturation = AdjSpec(label: "Saturation", range: -1...1, rail: stops([(0x7c7c7c, 0), (0x9d8a78, 0.5), (0xe8663f, 0.78), (0xd9458f, 1)]))
    static let warmth = AdjSpec(label: "Warmth", range: -1...1, rail: stops([(0x4d8fe6, 0), (0x5f5a52, 0.5), (0xf0a53a, 1)]))
    static let tint = AdjSpec(label: "Tint", range: -1...1, rail: stops([(0x4dbb72, 0), (0x5f5a5f, 0.5), (0xd25ad2, 1)]))
}

/// One adjustment: label, a value that reads as text and becomes a field when tapped, and a
/// painted rail with a centre notch, an amber bar from neutral, and a thumb that turns amber once
/// changed. Double-tap resets.
struct AdjSlider: View {
    let spec: AdjSpec
    let value: Double
    var reset: Double = 0
    let onChange: (Double) -> Void
    @State private var dragging = false
    @State private var editing = false
    @State private var draft = ""
    @FocusState private var focused: Bool

    private var changed: Bool { abs(value - reset) > 0.004 }
    private var text: String {
        let n = Int((value * 100).rounded())
        return spec.bipolar && n > 0 ? "+\(n)" : "\(n)"
    }
    private func fraction(_ v: Double) -> Double { (v - spec.range.lowerBound) / (spec.range.upperBound - spec.range.lowerBound) }

    var body: some View {
        VStack(spacing: 4) {
            HStack {
                Text(spec.label).font(.system(size: 12)).foregroundStyle(changed ? ProTheme.ink : ProTheme.muted)
                Spacer()
                if editing {
                    TextField("", text: $draft).focused($focused).keyboardType(.numbersAndPunctuation).multilineTextAlignment(.trailing)
                        .font(.system(size: 11, weight: .medium, design: .monospaced)).foregroundStyle(ProTheme.ink)
                        .frame(width: 44, height: 20).padding(.horizontal, 6)
                        .background(SS.field, in: RoundedRectangle(cornerRadius: 4))
                        .overlay { RoundedRectangle(cornerRadius: 4).strokeBorder(ProTheme.accent, lineWidth: 1) }
                        .onSubmit(commit).onChange(of: focused) { _, f in if !f { commit() } }
                } else {
                    Text(text).font(.system(size: 11, weight: .medium, design: .monospaced)).monospacedDigit()
                        .foregroundStyle(ProTheme.muted).frame(width: 44, height: 20, alignment: .trailing).padding(.horizontal, 6)
                        .contentShape(Rectangle())
                        .onTapGesture { draft = String(Int((value * 100).rounded())); editing = true; focused = true }
                }
            }
            GeometryReader { geo in
                let w = geo.size.width
                let x = w * fraction(value), mid = w * fraction(spec.bipolar ? 0 : reset)
                ZStack(alignment: .leading) {
                    rail.frame(height: 6).clipShape(RoundedRectangle(cornerRadius: 3))
                        .overlay { RoundedRectangle(cornerRadius: 3).strokeBorder(.black.opacity(0.35), lineWidth: 1) }
                        .opacity(dragging ? 1 : 0.85)
                    if spec.bipolar {
                        Rectangle().fill(.white.opacity(0.45)).frame(width: 1, height: 12).shadow(color: .black.opacity(0.4), radius: 0.5).offset(x: w / 2)
                    }
                    if changed {   // how far from neutral: an amber bar just under the rail
                        Capsule().fill(ProTheme.accent).frame(width: abs(x - mid), height: 2).offset(x: min(x, mid), y: 5)
                    }
                    Circle().fill(changed ? ProTheme.accent : Color(proHex: 0xd9d6cf))
                        .frame(width: 12, height: 12)
                        .overlay { Circle().strokeBorder(Color(proHex: 0x0b0b0d), lineWidth: 2).padding(-2) }
                        .shadow(color: .black.opacity(0.8), radius: 2, y: 1)
                        .scaleEffect(dragging ? 1.2 : 1)
                        .offset(x: x - 6)
                }
                .frame(height: 16)
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 0).onChanged { g in
                    dragging = true
                    let f = min(1, max(0, g.location.x / w))
                    onChange(((spec.range.lowerBound + f * (spec.range.upperBound - spec.range.lowerBound)) * 100).rounded() / 100)
                }.onEnded { _ in dragging = false })
                .simultaneousGesture(TapGesture(count: 2).onEnded { onChange(reset) })
            }
            .frame(height: 16)
            .padding(.horizontal, 6)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spec.label).accessibilityValue(text)
        .accessibilityAdjustableAction { dir in onChange(min(spec.range.upperBound, max(spec.range.lowerBound, value + (dir == .increment ? 0.05 : -0.05)))) }
    }

    @ViewBuilder private var rail: some View {
        if let split = spec.split {
            VStack(spacing: 0) {
                LinearGradient(stops: spec.rail, startPoint: .leading, endPoint: .trailing)
                LinearGradient(stops: split, startPoint: .leading, endPoint: .trailing)
            }
        } else {
            LinearGradient(stops: spec.rail, startPoint: .leading, endPoint: .trailing)
        }
    }

    private func commit() {
        editing = false
        if let n = Double(draft.replacingOccurrences(of: "+", with: "")) { onChange(min(spec.range.upperBound, max(spec.range.lowerBound, n / 100))) }
    }
}

/// White balance as a pad: cool → warm across, green → magenta up (`.ss-balance`); drag the puck,
/// double-tap to reset, or use the eyedropper on something that should be grey.
struct BalancePad: View {
    let warmth: Double
    let tint: Double
    @Binding var picking: Bool
    let onChange: (Double, Double) -> Void

    private var changed: Bool { abs(warmth) > 0.004 || abs(tint) > 0.004 }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("White balance").font(.system(size: 12)).foregroundStyle(changed ? ProTheme.ink : ProTheme.muted)
                Spacer()
                Button { picking.toggle() } label: {
                    Label("Neutral", systemImage: "eyedropper").font(.system(size: 11, weight: .medium))
                        .padding(.horizontal, 8).frame(height: 22)
                        .background(picking ? ProTheme.accent : SS.panel2, in: RoundedRectangle(cornerRadius: 5))
                        .foregroundStyle(picking ? ProTheme.accentInk : ProTheme.muted)
                }.buttonStyle(.plain).accessibilityHint("Then tap something on the photo that should be neutral grey or white")
            }
            GeometryReader { geo in
                let w = geo.size.width, h = geo.size.height
                ZStack(alignment: .topLeading) {
                    LinearGradient(stops: AdjSpec.stops([(0x3f7fd6, 0), (0x4a5566, 0.4), (0x5f5a52, 0.6), (0xe39a36, 1)]), startPoint: .leading, endPoint: .trailing)
                    LinearGradient(stops: [.init(color: Color(proHex: 0xd25ad2).opacity(0.55), location: 0), .init(color: .clear, location: 0.45),
                                           .init(color: .clear, location: 0.55), .init(color: Color(proHex: 0x4dbb72).opacity(0.55), location: 1)],
                                   startPoint: .top, endPoint: .bottom)
                    Rectangle().fill(.white.opacity(0.22)).frame(height: 1).offset(y: h / 2)
                    Rectangle().fill(.white.opacity(0.22)).frame(width: 1).offset(x: w / 2)
                    HStack { Text("COOL"); Spacer(); Text("WARM") }.font(.system(size: 9)).tracking(0.7).foregroundStyle(.white.opacity(0.55))
                        .padding(.horizontal, 6).frame(maxHeight: .infinity, alignment: .bottom).padding(.bottom, 3)
                    Circle().strokeBorder(changed ? ProTheme.accent : Color(proHex: 0xf4f1ea), lineWidth: 2).frame(width: 14, height: 14)
                        .shadow(color: .black.opacity(0.8), radius: 3, y: 2)
                        .position(x: w * (warmth + 1) / 2, y: h * (1 - tint) / 2)
                }
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay { RoundedRectangle(cornerRadius: 6).strokeBorder(.black.opacity(0.45), lineWidth: 1) }
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 0).onChanged { g in
                    let r = { (v: Double) in (min(1, max(-1, v)) * 100).rounded() / 100 }
                    onChange(r(g.location.x / w * 2 - 1), r(1 - g.location.y / h * 2))
                })
                .simultaneousGesture(TapGesture(count: 2).onEnded { onChange(0, 0) })
            }
            .frame(height: 92)
            .accessibilityElement().accessibilityLabel("White balance").accessibilityValue(String(format: "warmth %+.0f, tint %+.0f", warmth * 100, tint * 100))
        }
    }
}
