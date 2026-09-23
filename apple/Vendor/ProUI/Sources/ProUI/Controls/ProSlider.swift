import SwiftUI
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

public enum ProSliderThumb: String, CaseIterable, Sendable { case pointer, round }
public enum ProSliderTrack {
    case `default`, hue, saturation, luminance, colors([Color]), color(Color)
    var colors: [Color] {
        switch self {
        case .default: return [.black.opacity(0.5), .black.opacity(0.5)]
        case .hue: return [0xde6262, 0xd9c65c, 0x65ba72, 0x56bbbb, 0x6388d0, 0xad70cf, 0xde6262].map { Color(proHex: $0) }
        case .saturation: return [Color(proHex: 0x777777), Color(proHex: 0xda6961)]
        case .luminance: return [Color(proHex: 0x181818), Color(proHex: 0xdddddd)]
        case .colors(let colors): return colors.isEmpty ? [.clear] : colors
        case .color(let color): return [color, color]
        }
    }
    var isDefault: Bool { if case .default = self { return true }; return false }
}
public struct ProSliderLevels: Equatable, Sendable {
    public var left: Double, right: Double
    public init(left: Double, right: Double) { self.left = left; self.right = right }
}

public struct ProSlider: View {
    @Binding private var value: Double
    private let range: ClosedRange<Double>, step: Double, resetValue: Double
    private let disabled: Bool, label: String, precision: Int, valueWidth: CGFloat?, accentColor: Color?
    private let thumb: ProSliderThumb, track: ProSliderTrack, showValue: Bool, showTrack: Bool, levels: ProSliderLevels?, endpointHaptics: Bool
    private let onValueCommit: ((Double) -> Void)?
    @Environment(\.isEnabled) private var isEnabled
    @State private var hovering = false
    public init(value: Binding<Double>, in range: ClosedRange<Double> = 0...100, step: Double? = nil, resetValue: Double? = nil, disabled: Bool = false, label: String = "Value", precision: Int = 2, valueWidth: CGFloat? = nil, accentColor: Color? = nil, thumb: ProSliderThumb = .pointer, track: ProSliderTrack = .default, showValue: Bool = true, showTrack: Bool = true, levels: ProSliderLevels? = nil, endpointHaptics: Bool = false, onValueCommit: ((Double) -> Void)? = nil) {
        _value = value; self.range = range; self.step = step ?? ((range.upperBound - range.lowerBound) / 100 == 0 ? 1 : (range.upperBound - range.lowerBound) / 100)
        self.resetValue = resetValue ?? (range.lowerBound + range.upperBound) / 2; self.disabled = disabled; self.label = label
        self.precision = Swift.min(20, Swift.max(0, precision)); self.valueWidth = valueWidth; self.accentColor = accentColor
        self.thumb = thumb; self.track = track; self.showValue = showValue; self.showTrack = showTrack; self.levels = levels; self.endpointHaptics = endpointHaptics; self.onValueCommit = onValueCommit
    }
    public init(value: Binding<Double>, min: Double, max: Double, step: Double? = nil, resetValue: Double? = nil, disabled: Bool = false, label: String = "Value", precision: Int = 2, valueWidth: CGFloat? = nil, accentColor: Color? = nil, thumb: ProSliderThumb = .pointer, track: ProSliderTrack = .default, showValue: Bool = true, showTrack: Bool = true, levels: ProSliderLevels? = nil, endpointHaptics: Bool = false, onValueCommit: ((Double) -> Void)? = nil) {
        self.init(value: value, in: min...Swift.max(min, max), step: step, resetValue: resetValue, disabled: disabled, label: label, precision: precision, valueWidth: valueWidth, accentColor: accentColor, thumb: thumb, track: track, showValue: showValue, showTrack: showTrack, levels: levels, endpointHaptics: endpointHaptics, onValueCommit: onValueCommit)
    }
    private var enabled: Bool { isEnabled && !disabled }
    private var current: Double { ProRangeMath.normalized(value, min: range.lowerBound, max: range.upperBound, step: step) }
    private var binding: Binding<Double> {
        Binding(get: { current }, set: {
            guard enabled else { return }
            let next = ProRangeMath.normalized($0, min: range.lowerBound, max: range.upperBound, step: step)
            proPerformEndpointHapticIfNeeded(from: current, to: next, in: range, enabled: endpointHaptics)
            value = next
        })
    }
    private var readoutWidth: CGFloat {
        valueWidth ?? CGFloat(Swift.max(3, String(format: "%.*f", precision, range.lowerBound).count, String(format: "%.*f", precision, range.upperBound).count)) * 6.65 + 4
    }
    public var body: some View {
        HStack(spacing: 2) {
            if showTrack {
                ProRangeRail(value: binding, range: range, step: step, resetValue: resetValue, enabled: enabled, label: label,
                             kind: thumb == .pointer ? .pointer : .round, track: track, levels: levels,
                             valueText: String(format: "%.*f", precision, current), highlighted: hovering,
                             onValueCommit: onValueCommit)
                    .frame(minWidth: thumb == .pointer ? 24 : 60)
            }
            if showValue {
                ProValueReadout(value: binding, range: range, step: step, precision: precision, enabled: enabled, label: label,
                                accentColor: accentColor, highlighted: hovering, onValueCommit: onValueCommit)
                    .frame(width: readoutWidth)
                    .opacity(enabled ? 1 : 0.4)
            }
        }
        .frame(height: 22).onHover { hovering = $0 }
    }
}
public typealias ProInspectorSlider = ProSlider

struct ProPointerThumb: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: 0, y: 1)); p.addLine(to: CGPoint(x: 0, y: 6.2))
        p.addQuadCurve(to: CGPoint(x: 0.3, y: 7), control: CGPoint(x: 0, y: 6.7))
        p.addLine(to: CGPoint(x: 4, y: 10.5)); p.addQuadCurve(to: CGPoint(x: 5.3, y: 10.5), control: CGPoint(x: 4.65, y: 11.2))
        p.addLine(to: CGPoint(x: 9, y: 7)); p.addQuadCurve(to: CGPoint(x: 9.2, y: 6.2), control: CGPoint(x: 9.2, y: 6.7))
        p.addLine(to: CGPoint(x: 9.2, y: 1)); p.addQuadCurve(to: CGPoint(x: 8.2, y: 0), control: CGPoint(x: 9.2, y: 0))
        p.addLine(to: CGPoint(x: 1, y: 0)); p.addQuadCurve(to: CGPoint(x: 0, y: 1), control: CGPoint(x: 0, y: 0)); p.closeSubpath()
        return p.applying(CGAffineTransform(scaleX: rect.width / 9.2, y: rect.height / 11))
    }
}

struct ProRangeRail: View {
    enum Kind { case pointer, round, subbar }
    @Binding var value: Double
    let range: ClosedRange<Double>, step: Double, resetValue: Double?, enabled: Bool, label: String, kind: Kind
    var track: ProSliderTrack = .default
    var levels: ProSliderLevels?
    var valueText: String?
    var highlighted = false
    var tint = ProTheme.accent
    var onValueCommit: ((Double) -> Void)?
    var height: CGFloat = 22
    @State private var drag: (x: CGFloat, value: Double)?
    @State private var hovering = false
    @FocusState private var focused: Bool
    private var progress: Double { ProRangeMath.progress(value, min: range.lowerBound, max: range.upperBound) }
    private var inset: CGFloat { kind == .pointer ? 4.6 : kind == .round ? (height - 2) / 2 : 5.5 }
    private func change(_ next: Double) {
        guard enabled else { return }
        let rounded = kind == .pointer ? ProRangeMath.normalized(next, min: range.lowerBound, max: range.upperBound, step: step) : (next * 1_000_000).rounded() / 1_000_000
        let nextValue = ProRangeMath.clamp(rounded, min: range.lowerBound, max: range.upperBound)
        value = nextValue
    }
    private func reset() { guard enabled, let resetValue else { return }; change(resetValue); onValueCommit?(value) }
    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            let thumbX = inset + Swift.max(0, width - inset * 2) * progress
            ZStack(alignment: .topLeading) {
                if kind == .round {
                    RoundedRectangle(cornerRadius: height / 2, style: .continuous).fill(track.isDefault ? AnyShapeStyle(ProTheme.seam) : AnyShapeStyle(LinearGradient(colors: track.colors, startPoint: .leading, endPoint: .trailing)))
                        .overlay { RoundedRectangle(cornerRadius: height / 2, style: .continuous).strokeBorder(.black.opacity(0.22), lineWidth: 1) }
                        .overlay(alignment: .top) { RoundedRectangle(cornerRadius: height / 2, style: .continuous).stroke(.black.opacity(0.28), lineWidth: 1).blur(radius: 1).padding(.top, 1) }
                        .shadow(color: .white.opacity(0.09), radius: 0, y: 0.5)
                    if let levels {
                        VStack(spacing: 2) { meter(levels.left); meter(levels.right) }.padding(.horizontal, height < 22 ? 8 : 10).padding(.vertical, height < 22 ? 4 : 5)
                    }
                    Circle().fill(LinearGradient(colors: [Color(proHex: focused ? 0xd7d7d7 : 0xc5c5c5), Color(proHex: focused ? 0xaaaaaa : 0x969696)], startPoint: .top, endPoint: .bottom))
                        .overlay { Circle().strokeBorder(.black.opacity(0.4), lineWidth: 0.5) }
                        .overlay(alignment: .top) { Circle().trim(from: 0.5, to: 1).stroke(.white.opacity(0.4), lineWidth: 0.5).rotationEffect(.degrees(0)).padding(0.5) }
                        .shadow(color: .black.opacity(0.47), radius: 1, y: 1)
                        .frame(width: height - 2, height: height - 2).position(x: thumbX, y: height / 2)
                    if drag != nil, let valueText, !valueText.isEmpty {
                        Text(valueText).font(.system(size: height < 22 ? 9 : 10, weight: .medium)).monospacedDigit().foregroundStyle(Color(proHex: 0xdddddd))
                            .padding(.horizontal, 6).padding(.vertical, 3).background(ProTheme.seam, in: RoundedRectangle(cornerRadius: 2, style: .continuous))
                            .shadow(color: .black.opacity(0.4), radius: 3, y: 2).fixedSize().position(x: thumbX, y: -15)
                    }
                } else if kind == .pointer {
                    RoundedRectangle(cornerRadius: 1, style: .continuous).fill(LinearGradient(colors: track.colors, startPoint: .leading, endPoint: .trailing))
                        .frame(width: Swift.max(0, width - 4), height: 2).offset(x: 4, y: 10).shadow(color: .white.opacity(0.05), radius: 0, y: 1)
                    ProPointerThumb().fill(Color(proHex: enabled && (highlighted || hovering || focused || drag != nil) ? 0xb3b3b3 : 0x808080))
                        .overlay { ProPointerThumb().stroke(Color(proHex: 0x181818), lineWidth: 0.2) }
                        .shadow(color: .black.opacity(0.3), radius: 2, y: 1)
                        .frame(width: 9.2, height: 11).position(x: thumbX, y: 10.5)
                } else {
                    Capsule().fill(Color(proHex: 0x626262)).frame(height: 3).offset(y: 9.5)
                    Capsule().fill(tint).frame(width: width * progress, height: 3).offset(y: 9.5)
                    Circle().fill(Color(proHex: 0xd0d0d0)).frame(width: 11, height: 11)
                        .shadow(color: .black.opacity(0.2), radius: 1, y: 1).position(x: thumbX, y: 11)
                }
            }.opacity(enabled ? 1 : 0.4)
            .frame(width: width, height: height).contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { event in
                guard enabled else { return }
                focused = true
                let scale = proModifierScale()
                let gestureInset: CGFloat = kind == .pointer ? 4.6 : 8
                if drag == nil {
                    if scale == 1 { change(ProRangeMath.value(at: event.startLocation.x, width: width, inset: gestureInset, min: range.lowerBound, max: range.upperBound)) }
                    drag = (event.startLocation.x, value)
                }
                if let previous = drag {
                    let next = previous.value + (event.location.x - previous.x) / Swift.max(1, width - gestureInset * 2) * (range.upperBound - range.lowerBound) * scale
                    let clamped = ProRangeMath.clamp(next, min: range.lowerBound, max: range.upperBound)
                    drag = (event.location.x, clamped); change(clamped)
                }
            }.onEnded { _ in guard drag != nil else { return }; drag = nil; if enabled { onValueCommit?(value) } })
            .simultaneousGesture(TapGesture(count: 2).onEnded { reset() })
        }
        .frame(height: height)
        .modifier(ProRangeKeyboard(enabled: enabled, value: value, min: range.lowerBound, max: range.upperBound, step: step, update: change, commit: { onValueCommit?(value) }, cancel: { drag = nil }))
        .focused($focused).onHover { hovering = $0 }
        .proDisabledCursor(!enabled)
        .onChange(of: enabled) { _, enabled in if !enabled { drag = nil } }
        .onDisappear { drag = nil }
        .accessibilityElement(children: .ignore).accessibilityLabel(label).accessibilityValue(valueText ?? String(value))
        .accessibilityAdjustableAction { direction in
            guard enabled else { return }; change(value + (direction == .increment ? step : -step)); onValueCommit?(value)
        }
    }
    private func meter(_ level: Double) -> some View {
        GeometryReader { geo in
            RoundedRectangle(cornerRadius: 1, style: .continuous).fill(.white.opacity(0.047))
                .overlay(alignment: .leading) {
                    LinearGradient(stops: [.init(color: Color(proHex: 0x74af89), location: 0), .init(color: Color(proHex: 0x74af89), location: 0.78), .init(color: Color(proHex: 0xe1be61), location: 0.78), .init(color: Color(proHex: 0xe1be61), location: 0.96), .init(color: Color(proHex: 0xd56b63), location: 0.96)], startPoint: .leading, endPoint: .trailing)
                        .mask(alignment: .leading) { Rectangle().frame(width: geo.size.width * ProRangeMath.clamp(level, min: 0, max: 1)) }
                }.clipShape(RoundedRectangle(cornerRadius: 1, style: .continuous))
        }
    }
}

private struct ProValueReadout: View {
    @Binding var value: Double
    let range: ClosedRange<Double>, step: Double, precision: Int, enabled: Bool, label: String
    let accentColor: Color?, highlighted: Bool, onValueCommit: ((Double) -> Void)?
    @State private var editing = false
    @State private var draft = ""
    @State private var drag: (y: CGFloat, value: Double, moved: Bool)?
    @FocusState private var fieldFocused: Bool
    @FocusState private var readoutFocused: Bool
    private var text: String { String(format: "%.*f", precision, value) }
    private func change(_ next: Double) { if enabled { value = ProRangeMath.normalized(next, min: range.lowerBound, max: range.upperBound, step: step) } }
    private func startEditing() { guard enabled else { return }; draft = text; editing = true; fieldFocused = true }
    private func finishEditing(commit: Bool) {
        guard editing else { return }; editing = false; fieldFocused = false
        if commit, let parsed = Double(draft.trimmingCharacters(in: .whitespacesAndNewlines)), parsed.isFinite { change(parsed); onValueCommit?(value) }
        readoutFocused = true
    }
    var body: some View {
        ZStack {
            if editing {
                TextField(label + " value", text: $draft).textFieldStyle(.plain).multilineTextAlignment(.center)
                    .padding(.horizontal, 1).frame(height: 20).background(ProTheme.input, in: RoundedRectangle(cornerRadius: 3, style: .continuous))
                    .overlay { RoundedRectangle(cornerRadius: 3, style: .continuous).strokeBorder(Color(proHex: 0x181818), lineWidth: 0.5) }
                    .focusEffectDisabled()
                    .focused($fieldFocused).onSubmit { finishEditing(commit: true) }
                    .onKeyPress(.escape) { finishEditing(commit: false); return .handled }
                    .onChange(of: fieldFocused) { _, focused in if !focused { finishEditing(commit: true) } }
                    .onAppear { fieldFocused = true }
            } else {
                Text(text).frame(maxWidth: .infinity).frame(height: 20).contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 0).onChanged { event in
                        guard enabled else { return }
                        if drag == nil { drag = (event.startLocation.y, value, false) }
                        guard let previous = drag else { return }
                        let distance = previous.y - event.location.y
                        guard previous.moved || abs(distance) > 3 else { return }
                        let next = previous.value + Double(distance) * (range.upperBound - range.lowerBound) / 200 * proModifierScale()
                        drag = (event.location.y, ProRangeMath.clamp(next, min: range.lowerBound, max: range.upperBound), true); change(next)
                    }.onEnded { _ in
                        guard let previous = drag else { return }; drag = nil
                        if previous.moved { onValueCommit?(value) } else { startEditing() }
                    })
                    .modifier(ProRangeKeyboard(enabled: enabled, value: value, min: range.lowerBound, max: range.upperBound, step: step, update: change, edit: startEditing, cancel: { drag = nil }))
                    .focused($readoutFocused)
                    .proDisabledCursor(!enabled)
            }
            if enabled && !editing && (highlighted || readoutFocused || drag?.moved == true) {
                VStack { ProChevron(down: false).stroke(style: StrokeStyle(lineWidth: 1.25, lineCap: .round, lineJoin: .round)).frame(width: 11, height: 3.6); Spacer(minLength: 0); ProChevron().stroke(style: StrokeStyle(lineWidth: 1.25, lineCap: .round, lineJoin: .round)).frame(width: 11, height: 3.6) }
                    .foregroundStyle(accentColor ?? Color(proHex: 0xbcbcbc)).padding(.vertical, -1).allowsHitTesting(false)
            }
        }
        .font(.system(size: 11, weight: .medium)).monospacedDigit().foregroundStyle(.white.opacity(0.85)).frame(height: 22)
        .onChange(of: enabled) { _, enabled in if !enabled { drag = nil; finishEditing(commit: false) } }
        .onDisappear { drag = nil }
        .accessibilityLabel(label + " value").accessibilityValue(text)
        .accessibilityAdjustableAction { direction in change(value + (direction == .increment ? step : -step)) }
    }
}

private enum ProSliderEndpoint { case lower, upper }

private func proSliderEndpoint(for value: Double, in range: ClosedRange<Double>) -> ProSliderEndpoint? {
    if value <= range.lowerBound { return .lower }
    if value >= range.upperBound { return .upper }
    return nil
}

func proPerformEndpointHapticIfNeeded(from previousValue: Double, to nextValue: Double, in range: ClosedRange<Double>, enabled: Bool) {
    guard enabled else { return }
    let previousEndpoint = proSliderEndpoint(for: previousValue, in: range)
    guard let nextEndpoint = proSliderEndpoint(for: nextValue, in: range), nextEndpoint != previousEndpoint else { return }
    proPerformEndpointHaptic()
}

private func proPerformEndpointHaptic() {
    #if os(macOS)
    NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)
    #elseif os(iOS)
    UISelectionFeedbackGenerator().selectionChanged()
    #endif
}
