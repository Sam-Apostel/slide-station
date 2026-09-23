import ProUI
import SlideKit
import SwiftUI

/// Studio mode (iPad, regular width): the desktop app's layout — filmstrip | stage | inspector —
/// on ProUI's controls, for trackpad and pencil. Same keys: ← → move, Space develops, R turns,
/// X skips, B shows the scan before, 1–9 toggle bracket scans.
struct StudioView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("studio") private var studio = false
    @State private var before = false

    var body: some View {
        if let tray = model.tray {
            VStack(spacing: 0) {
                toolbar(tray)
                HStack(spacing: 0) {
                    Filmstrip(tray: tray).frame(width: 132)
                    Rectangle().fill(ProTheme.seam).frame(width: 1)
                    stage(tray)
                    Rectangle().fill(ProTheme.seam).frame(width: 1)
                    if let slide = model.slide { Inspector(tray: tray, slide: slide) } else { ProInspector(width: 300) { Spacer() } }
                }
                statusbar(tray)
            }
            .background(ProTheme.background)
            .proTheme()
            .background { shortcuts }
        }
    }

    private func toolbar(_ tray: Tray) -> some View {
        ProToolbar {
            ProButton(action: { model.close() }) { Label("Trays", systemImage: "chevron.left") }
            Text(tray.name).font(.system(size: 13, weight: .semibold)).padding(.leading, 6)
            if !tray.date.isEmpty { Text(tray.date).foregroundStyle(ProTheme.muted) }
            Spacer()
            ProButton("Simple", action: { studio = false })
            let s = tray.summary()
            ProButton(size: .md, active: true, action: { model.upload(onlyReady: true) }) {
                Label("Upload \(s.readyUpload) developed", systemImage: "icloud.and.arrow.up")
            }.disabled(s.readyUpload == 0 || model.busy)
        }
        .font(.system(size: 12))
    }

    private func stage(_ tray: Tray) -> some View {
        VStack(spacing: 0) {
            ZStack {
                ProTheme.well
                if let slide = model.slide {
                    SlideImage(tray: tray, slide: slide, edge: 2000, before: before).padding(24)
                    if before { Text("BEFORE").font(.system(size: 11, weight: .semibold)).tracking(1).padding(6).background(.black.opacity(0.6)).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).padding(30) }
                } else {
                    FinishLine(tray: tray)
                }
            }
            .onLongPressGesture(minimumDuration: 0.2, maximumDistance: 10) {} onPressingChanged: { before = $0 }
            if let slide = model.slide { ScanStrip(tray: tray, slide: slide) }
        }
        .frame(maxWidth: .infinity)
    }

    private func statusbar(_ tray: Tray) -> some View {
        let s = tray.summary()
        return ProStatusbar {
            Text(model.selection < tray.groups.count ? "Slide \(model.selection + 1) of \(tray.groups.count)" : "\(tray.groups.count) slides")
            Text("\(s.developed) done").foregroundStyle(ProTheme.accent)
            Text("\(s.uploaded) in Immich").foregroundStyle(ProTheme.green)
            if s.skipped > 0 { Text("\(s.skipped) skipped") }
            Spacer()
            if let slide = model.slide { Text(Tray.status(slide).label).foregroundStyle(Tray.status(slide).color) }
        }
    }

    private var shortcuts: some View {
        Group {
            Button("") { model.next() }.keyboardShortcut(.rightArrow, modifiers: [])
            Button("") { model.previous() }.keyboardShortcut(.leftArrow, modifiers: [])
            Button("") { model.keep() }.keyboardShortcut(.space, modifiers: [])
            Button("") { model.turn() }.keyboardShortcut("r", modifiers: [])
            Button("") { model.turn(clockwise: false) }.keyboardShortcut("r", modifiers: .shift)
            Button("") { model.skip(advance: false) }.keyboardShortcut("x", modifiers: [])
            Button("") { before.toggle() }.keyboardShortcut("b", modifiers: [])
            ForEach(1..<10) { n in
                Button("") { if let s = model.slide, n <= s.scans.count { model.toggleScan(s.scans[n - 1]) } }
                    .keyboardShortcut(KeyEquivalent(Character(String(n))), modifiers: [])
            }
        }
        .opacity(0).accessibilityHidden(true)
    }
}

/// Slide mounts down the left edge, status on each.
struct Filmstrip: View {
    @Environment(AppModel.self) private var model
    let tray: Tray

    var body: some View {
        let statuses = model.statuses
        VStack(spacing: 0) {
            TrayGauge(statuses: statuses, current: model.selection).padding(8)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(Array(tray.groups.enumerated()), id: \.element.id) { i, g in
                            Button { model.select(i) } label: {
                                Mount(selected: i == model.selection) {
                                    SlideImage(tray: tray, slide: g, edge: 240).frame(height: 72)
                                }
                                .overlay(alignment: .bottomTrailing) { Circle().fill(statuses[i].color).frame(width: 8, height: 8).padding(9) }
                                .overlay(alignment: .topLeading) {
                                    Text("\(i + 1)").font(.system(size: 9, weight: .semibold).monospacedDigit()).foregroundStyle(i == model.selection ? ProTheme.accentInk : ProTheme.muted).padding(8)
                                }
                                .opacity(g.skip ? 0.45 : 1)
                            }
                            .buttonStyle(.plain).id(g.id)
                            .accessibilityLabel("Slide \(i + 1), \(statuses[i].label)")
                        }
                    }
                    .padding(.horizontal, 10).padding(.bottom, 10)
                }
                .onChange(of: model.selection) { _, i in
                    if tray.groups.indices.contains(i) { withAnimation { proxy.scrollTo(tray.groups[i].id, anchor: .center) } }
                }
            }
        }
        .background(ProTheme.canvas)
    }
}

/// The scans in the bracket, each switchable (1–9); best-of-bracket's picks are marked.
struct ScanStrip: View {
    @Environment(AppModel.self) private var model
    let tray: Tray
    let slide: Slide

    var body: some View {
        if slide.scans.count > 1 {
            HStack(spacing: 8) {
                Text("SCANS").font(.system(size: 10, weight: .medium)).tracking(0.8).foregroundStyle(ProTheme.dim)
                ForEach(Array(slide.scans.enumerated()), id: \.element) { i, scan in
                    let on = slide.activeScans.contains(scan)
                    Button { model.toggleScan(scan) } label: {
                        VStack(spacing: 3) {
                            AsyncThumb(url: model.renderer.thumbURL(tray.id, scan), rotation: slide.rotation)
                                .frame(width: 60, height: 40).clipShape(RoundedRectangle(cornerRadius: 3))
                                .overlay { RoundedRectangle(cornerRadius: 3).strokeBorder(on ? ProTheme.accent : ProTheme.line, lineWidth: on ? 1.5 : 1) }
                                .opacity(on ? 1 : 0.4)
                            Text(slide.autoExcluded?[scan] ?? "\(i + 1)").font(.system(size: 9)).foregroundStyle(ProTheme.muted)
                        }
                    }.buttonStyle(.plain).accessibilityLabel("Scan \(i + 1), \(on ? "in" : "left out")")
                }
                Spacer()
            }
            .padding(.horizontal, 12).frame(height: 64)
            .background(ProTheme.bar)
        }
    }
}

struct AsyncThumb: View {
    let url: URL
    var rotation = 0
    @State private var image: UIImage?
    var body: some View {
        ZStack { if let image { Image(uiImage: image).resizable().scaledToFill().rotationEffect(.degrees(Double(rotation))) } else { ProTheme.well } }
            .task(id: url) { image = await Task.detached { UIImage(contentsOfFile: url.path) }.value }
    }
}

/// The right rail: histogram, Restore / Light / Colour / Frame / Date, and Develop pinned below.
struct Inspector: View {
    @Environment(AppModel.self) private var model
    let tray: Tray
    let slide: Slide
    @State private var histogram: [String: [Int]] = [:]

    var body: some View {
        ProInspector(width: 300) {
            ScrollView {
                VStack(spacing: 0) {
                    Histogram(data: histogram).frame(height: 70).padding(12)
                        .task(id: "\(slide.id)|\(slide.params.strength)|\(slide.params.trim)|\(slide.rotation)|\(slide.activeScans)") {
                            let renderer = model.renderer, t = tray, s = slide
                            try? await Task.sleep(for: .milliseconds(120))
                            guard !Task.isCancelled else { return }
                            histogram = await Task.detached { (try? renderer.histogram(t, s)) ?? [:] }.value
                        }
                    ProDisclosureGroup(title: "Restore", summary: String(format: "%.0f %%", slide.params.strength * 100)) {
                        field("Auto restore", \.strength, 0...1, reset: tray.defaults.strength)
                        HStack {
                            Text("Trim mount edges").foregroundStyle(ProTheme.muted)
                            Spacer()
                            Toggle("", isOn: Binding(get: { slide.params.trim }, set: { model.setTrim($0) })).labelsHidden().scaleEffect(0.8)
                        }.padding(.horizontal, 12).padding(.bottom, 8)
                    }
                    ProDisclosureGroup(title: "Light") {
                        field("Brightness", \.brightness, -1...1)
                        field("Contrast", \.contrast, -1...1)
                    }
                    ProDisclosureGroup(title: "Colour") {
                        field("Warmth", \.warmth, -1...1, track: .colors([Color(proHex: 0x6d9bd6), Color(proHex: 0x777777), Color(proHex: 0xe0a255)]))
                        field("Tint", \.tint, -1...1, track: .colors([Color(proHex: 0x6fbf73), Color(proHex: 0x777777), Color(proHex: 0xc76fb8)]))
                        field("Saturation", \.saturation, -1...1, track: .saturation)
                    }
                    ProDisclosureGroup(title: "Frame", summary: "\(slide.rotation)°") {
                        HStack(spacing: 6) {
                            ProButton(action: { model.turn(clockwise: false) }) { Label("Left", systemImage: "rotate.left") }
                            ProButton(action: { model.turn() }) { Label("Right", systemImage: "rotate.right") }
                            Spacer()
                            if slide.rotReason == "faces" || slide.rotReason == "sky" {
                                Text("guessed from \(slide.rotReason)").font(.system(size: 10)).foregroundStyle(ProTheme.dim)
                            }
                        }.padding(12)
                    }
                    ProDisclosureGroup(title: "Date & caption", summary: dateSummary) {
                        MetaFields(slide: slide, estimated: SlideDates.estimate(tray)[model.selection])
                    }
                    HStack {
                        ProButton("Reset slide", action: { model.resetParams() })
                        Spacer()
                        if let src = slide.paramsSource { Text(src == "manual" ? "by hand" : src).font(.system(size: 10)).foregroundStyle(ProTheme.dim) }
                    }.padding(12)
                }
            }
            VStack(spacing: 8) {
                HStack(spacing: 6) {
                    ProButton(size: .lg, active: slide.skip, activeTint: ProTheme.destructive.opacity(0.6), fullWidth: true, action: { model.skip(advance: false) }) { Text("Skip") }
                    ProButton(size: .lg, active: !slide.reviewed, fullWidth: true, action: { slide.reviewed ? model.toggleDeveloped() : model.keep() }) {
                        Text(slide.reviewed ? "Developed ✓" : "Develop")
                    }
                }
            }
            .padding(12)
            .background(ProTheme.panel)
            .overlay(alignment: .top) { Rectangle().fill(ProTheme.seam).frame(height: 1) }
        }
    }

    private var dateSummary: String { slide.date ?? SlideDates.estimate(tray)[model.selection].value }

    private func field(_ label: String, _ key: WritableKeyPath<Params, Double>, _ range: ClosedRange<Double>, reset: Double = 0, track: ProSliderTrack = .default) -> some View {
        VStack(spacing: 1) {
            HStack { Text(label).foregroundStyle(Color(proHex: 0xc4c4c4)); Spacer() }.font(.system(size: 11)).frame(height: 14)
            ProSlider(value: Binding(get: { slide.params[keyPath: key] }, set: { model.setParam(key, $0) }),
                      in: range, step: 0.01, resetValue: reset, label: label, precision: 2, track: track)
        }
        .padding(.horizontal, 12).padding(.vertical, 5)
    }
}

struct MetaFields: View {
    @Environment(AppModel.self) private var model
    let slide: Slide
    let estimated: SlideDate
    @State private var date = ""
    @State private var caption = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField(estimated.value.isEmpty ? "1978-08" : "\(estimated.value) (\(estimated.source.rawValue))", text: $date)
                .textFieldStyle(.plain).keyboardType(.numbersAndPunctuation)
                .padding(6).background(ProTheme.input, in: RoundedRectangle(cornerRadius: 4))
                .onChange(of: date) { _, v in if v != (slide.date ?? "") { model.setDate(v) } }
            TextField("Caption (Immich description)", text: $caption, axis: .vertical)
                .textFieldStyle(.plain).lineLimit(1...4)
                .padding(6).background(ProTheme.input, in: RoundedRectangle(cornerRadius: 4))
                .onChange(of: caption) { _, v in if v != (slide.caption ?? "") { model.setCaption(v) } }
        }
        .font(.system(size: 12))
        .padding(12)
        .task(id: slide.id) { date = slide.date ?? ""; caption = slide.caption ?? "" }
    }
}

/// Per-channel histograms of what the tone curve works on (the web app's curve background).
struct Histogram: View {
    let data: [String: [Int]]
    var body: some View {
        Canvas { ctx, size in
            ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .color(ProTheme.well))
            let channels: [(String, Color)] = [("r", Color(proHex: 0xdc7d7d)), ("g", Color(proHex: 0x88bb92)), ("b", Color(proHex: 0x85a7d6))]
            let peak = Double(channels.compactMap { data[$0.0]?.dropFirst().dropLast().max() }.max() ?? 1)
            for (key, color) in channels {
                guard let bins = data[key], !bins.isEmpty else { continue }
                var p = Path()
                p.move(to: CGPoint(x: 0, y: size.height))
                for (i, v) in bins.enumerated() {
                    let x = size.width * CGFloat(i) / CGFloat(bins.count - 1)
                    p.addLine(to: CGPoint(x: x, y: size.height - size.height * min(1, CGFloat(Double(v) / max(1, peak)))))
                }
                p.addLine(to: CGPoint(x: size.width, y: size.height)); p.closeSubpath()
                ctx.fill(p, with: .color(color.opacity(0.4)))
            }
        }
        .overlay { Rectangle().strokeBorder(ProTheme.seam, lineWidth: 1) }
        .accessibilityLabel("Colour histogram")
    }
}
