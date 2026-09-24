import ProUI
import SlideKit
import SwiftUI

/// The filmstrip (`components/filmstrip.tsx`): the tray's name and count, the tray from above,
/// All / To develop / HDR filters, and the slides as mounts, two to a row.
struct FilmstripPanel: View {
    @Environment(AppModel.self) private var model
    let tray: Tray
    @AppStorage("filmstripFilter") private var filter = "all"
    @State private var seen: [String: SlideStatus] = [:]
    @State private var gilding: Set<String> = []

    private func matches(_ g: Slide) -> Bool {
        switch filter {
        case "develop": !g.developed && !g.skip
        case "hdr": g.scans.count > 1
        default: true
        }
    }

    var body: some View {
        let statuses = model.statuses
        let dates = SlideDates.estimate(tray)
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                Text(tray.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                Text("\(tray.groups.count) slides · \(tray.scans.count) scans").font(.system(size: 11)).foregroundStyle(ProTheme.muted)
                TraySlots(statuses: statuses, current: model.selection < tray.groups.count ? model.selection : nil) { model.select($0) }
                    .padding(.top, 6)
            }
            .padding(.horizontal, 10).padding(.top, 10).padding(.bottom, 10)
            ProScopebar {
                ProScope("All", active: filter == "all") { filter = "all" }
                ProScope("To develop", active: filter == "develop") { filter = "develop" }
                ProScope("HDR", active: filter == "hdr") { filter = "hdr" }
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                        ForEach(Array(tray.groups.enumerated()).filter { matches($0.element) }, id: \.element.id) { i, g in
                            Button { model.select(i) } label: {
                                MountTile(tray: tray, slide: g, index: i, status: statuses[i], date: dates[i],
                                          current: i == model.selection, gilding: gilding.contains(g.id))
                            }
                            .buttonStyle(.plain).id(g.id)
                            .accessibilityLabel("Slide \(i + 1), \(statuses[i].label)")
                            .accessibilityAddTraits(i == model.selection ? .isSelected : [])
                            .contextMenu {
                                if !(g.developed && g.immich != nil) {  // an uploaded slide stays developed
                                    Button(g.reviewed ? "Not developed" : "Develop", systemImage: "checkmark") { model.select(i); model.toggleDeveloped() }
                                }
                                Button(g.skip ? "Don't skip" : "Skip", systemImage: "xmark") { model.select(i); model.skip(advance: false) }
                                Button("Rotate right", systemImage: "rotate.right") { model.select(i); model.turn() }
                                Button("Rotate left", systemImage: "rotate.left") { model.select(i); model.turn(clockwise: false) }
                            }
                        }
                    }
                    .padding(12)
                }
                .onChange(of: model.selection) { _, i in
                    if tray.groups.indices.contains(i) { withAnimation(.snappy) { proxy.scrollTo(tray.groups[i].id, anchor: nil) } }
                }
            }
        }
        .background(ProTheme.canvas)
        // a slide that takes on a new finish (developed, uploaded) gets one sweep of light across it
        .onChange(of: statuses) { _, now in
            let fresh = tray.groups.indices.filter { i in
                guard let was = seen[tray.groups[i].id] else { return false }
                return now[i].finish != nil && was.finish != now[i].finish
            }.map { tray.groups[$0].id }
            seen = Dictionary(uniqueKeysWithValues: zip(tray.groups.map(\.id), now))
            guard !fresh.isEmpty else { return }
            gilding.formUnion(fresh)
            Task { try? await Task.sleep(for: .seconds(1)); gilding.subtract(fresh) }
        }
        .onAppear { seen = Dictionary(uniqueKeysWithValues: zip(tray.groups.map(\.id), statuses)) }
    }
}

/// The right rail (`components/inspector.tsx`): Frame, Tone curve, Adjust, Details, Tray, with
/// Develop and upload pinned below.
struct InspectorPanel: View {
    @Environment(AppModel.self) private var model
    let tray: Tray
    @Binding var picking: Bool
    let cropping: Bool
    let onCrop: () -> Void
    @State private var histogram: [String: [Int]] = [:]
    @AppStorage("inspector.frame") private var frameOpen = true
    @AppStorage("inspector.curve") private var curveOpen = true
    @AppStorage("inspector.adjust") private var adjustOpen = true
    @AppStorage("inspector.details") private var detailsOpen = false
    @AppStorage("inspector.tray") private var trayOpen = false

    var body: some View {
        ProInspector(width: 312) {
            ScrollView {
                VStack(spacing: 0) {
                    if let g = model.slide {
                        if g.locked != nil { lockedBanner }
                        Group {
                            ProDisclosureGroup(title: "Frame", expanded: $frameOpen, summary: frameNote(g)) { frameSection(g) }
                            ProDisclosureGroup(title: "Tone curve", expanded: $curveOpen, summary: ToneCurveView.note(g.params.curves)) {
                                ToneCurveView(slide: g, histogram: histogram).padding(.horizontal, 12).padding(.vertical, 10)
                            }
                            ProDisclosureGroup(title: "Adjust", expanded: $adjustOpen, summary: AdjustPanel.summary(g, defaults: tray.defaults)) {
                                if model.learningEnabled && model.learning.ready && g.feat != nil {
                                    Button(action: model.useLearned) { Image(systemName: "sparkles") }.accessibilityLabel("Use learned settings")
                                }
                                Button { model.resetParams() } label: { Image(systemName: "arrow.uturn.backward") }.accessibilityLabel("Reset all adjustments")
                            } content: {
                                AdjustPanel(tray: tray, slide: g, picking: $picking)
                            }
                            ProDisclosureGroup(title: "Details", expanded: $detailsOpen, summary: detailsNote(g)) {
                                MetaFields(slide: g, estimated: SlideDates.estimate(tray)[model.selection])
                            }
                        }
                        .disabled(g.locked != nil)
                        .opacity(g.locked != nil ? 0.55 : 1)
                    }
                    ProDisclosureGroup(title: "Tray", expanded: $trayOpen, summary: tray.name, showsBottomSeparator: false) { TrayFields(tray: tray) }
                }
            }
            .task(id: histogramKey) { await loadHistogram() }
            footer
        }
        .font(.system(size: 12))
        .foregroundStyle(ProTheme.ink)
    }

    // MARK: sections

    private func frameSection(_ g: Slide) -> some View {
        HStack(spacing: 6) {
            ProButtonGroup {
                ProButton(plain: true, action: { model.turn(clockwise: false) }) { Image(systemName: "rotate.left") }.accessibilityLabel("Rotate left")
                ProButton(plain: true, action: { model.turn() }) { Image(systemName: "rotate.right") }.accessibilityLabel("Rotate right")
                ProButton("180°", plain: true, action: { model.rotate(180) })
            }
            ProButton(active: cropping, activeTint: SS.panel2, action: onCrop) { Label("Crop", systemImage: "crop") }
            Spacer()
            if g.params.crop != nil || g.params.angle != 0 {
                ProButton(plain: true, action: { model.setFrame(crop: nil, angle: 0) }) { Image(systemName: "arrow.uturn.backward") }.accessibilityLabel("Remove crop and straighten")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
    }

    private func frameNote(_ g: Slide) -> String {
        var parts: [String] = []
        switch (g.rotation, g.rotReason) {
        case (0, _): parts.append("upright")
        case (let r, "faces"), (let r, "sky"): parts.append("\(r)° · guessed from \(g.rotReason)")
        case (let r, _): parts.append("\(r)°")
        }
        if g.params.crop != nil { parts.append("cropped") }
        if g.params.angle != 0 { parts.append("straightened") }
        return parts.joined(separator: " · ")
    }

    private func detailsNote(_ g: Slide) -> String {
        let d = SlideDates.estimate(tray)[model.selection]
        let date = d.value.isEmpty ? "no date" : d.source == .own ? d.value : "≈ \(d.value)"
        return g.caption.map { "\(date) · \($0)" } ?? date
    }

    private var lockedBanner: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "lock.fill").foregroundStyle(ProTheme.warn)
            VStack(alignment: .leading, spacing: 3) {
                Text("Locked — Immich has the final version").font(.system(size: 12, weight: .semibold))
                Text("The original scans were deleted after upload, so this slide can't be edited. Import its scans again to edit it.")
                    .font(.system(size: 11)).foregroundStyle(ProTheme.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .background(ProTheme.warn.opacity(0.08))
        .overlay(alignment: .bottom) { Rectangle().fill(ProTheme.warn.opacity(0.3)).frame(height: 1) }
    }

    // MARK: histogram of the curve's input

    private var histogramKey: String {
        guard let g = model.slide else { return "" }
        let p = g.params
        return "\(g.id)|\(g.activeScans)|\(g.rotation)|\(p.strength)|\(p.trim)|\(p.angle)|\(p.crop ?? [])"
    }

    private func loadHistogram() async {
        guard let g = model.slide else { return }
        try? await Task.sleep(for: .milliseconds(120))
        guard !Task.isCancelled else { return }
        let renderer = model.renderer, t = tray
        let h = await Task.detached { (try? renderer.histogram(t, g)) ?? [:] }.value
        if !Task.isCancelled { histogram = h }
    }

    // MARK: footer: develop and upload

    private var footer: some View {
        let s = tray.summary()
        let all = tray.groups.filter { !$0.skip }.count - s.uploaded
        return VStack(spacing: 8) {
            if let g = model.slide {
                HStack(spacing: 6) {
                    DevelopButton(done: g.developed) { g.developed ? model.next() : model.keep() }
                    ProButton(size: .lg, active: g.skip, activeTint: ProTheme.destructive.opacity(0.55), action: { model.skip(advance: false) }) {
                        Image(systemName: "xmark")
                    }.accessibilityLabel(g.skip ? "Don't skip" : "Skip")
                    ProButton(size: .lg, action: model.nextUndeveloped) { Image(systemName: "forward.end") }.accessibilityLabel("Next slide to develop")
                }
            }
            HStack(spacing: 6) {
                ProButton(size: .lg, active: s.readyUpload > 0, fullWidth: true, action: { model.upload(onlyReady: true) }) {
                    Label("Upload \(s.readyUpload) developed", systemImage: "square.and.arrow.up")
                }.disabled(s.readyUpload == 0 || model.busy)
                ProButton("All \(max(0, all))", size: .lg, action: { model.upload(onlyReady: false) }).disabled(all <= 0 || model.busy)
            }
            let blockers = model.cleanupBlockers
            HStack {
                ProButton(plain: true, action: model.cleanCard) { Label(tray.cardCleaned == true ? "Card cleaned" : "Clean card", systemImage: "sdcard") }
                    .disabled(!blockers.isEmpty || model.card == nil || model.busy || tray.cardCleaned == true)
                Spacer()
                if let b = blockers.first { Text(b).font(.system(size: 10)).foregroundStyle(ProTheme.dim).lineLimit(1).truncationMode(.tail) }
            }
        }
        .padding(12)
        .background(ProTheme.panel)
        .overlay(alignment: .top) { Rectangle().fill(ProTheme.seam).frame(height: 1) }
    }
}

/// "Develop" — the one button pressed for every slide, so it gets a little ceremony (`.ss-develop`):
/// an amber gradient with a highlight and dimples; once developed it steps back.
struct DevelopButton: View {
    let done: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: done ? "checkmark" : "camera.aperture").font(.system(size: 14, weight: .semibold))
                Text(done ? "Developed" : "Develop").font(.system(size: 13, weight: .semibold)).tracking(0.3)
                if !done { Image(systemName: "arrow.right").font(.system(size: 12, weight: .bold)) }
                Text("Space").font(.system(size: 10, weight: .medium))
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(done ? .white.opacity(0.08) : .black.opacity(0.14), in: RoundedRectangle(cornerRadius: 3))
                    .foregroundStyle(done ? ProTheme.muted : ProTheme.accentInk.opacity(0.7))
            }
            .frame(maxWidth: .infinity).frame(height: 38)
            .foregroundStyle(done ? ProTheme.accent : ProTheme.accentInk)
            .background {
                if done {
                    LinearGradient(colors: [Color(proHex: 0x202026), SS.panel2], startPoint: .top, endPoint: .bottom)
                } else {
                    LinearGradient(stops: [.init(color: Color(proHex: 0xf8cb77), location: 0), .init(color: ProTheme.accent, location: 0.48), .init(color: Color(proHex: 0xe39a2c), location: 1)],
                                   startPoint: .top, endPoint: .bottom)
                        .overlay { Dimples().fill(.black.opacity(0.07)) }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(alignment: .top) { RoundedRectangle(cornerRadius: 8).fill(.white.opacity(done ? 0.05 : 0.45)).frame(height: 1).padding(.horizontal, 6) }
            .overlay { RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(done ? ProTheme.accent.opacity(0.3) : .black.opacity(0.4), lineWidth: 1) }
            .shadow(color: done ? .clear : ProTheme.accent.opacity(0.35), radius: 9, y: 6)
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel(done ? "Developed — next slide" : "Develop and go to the next slide")
    }
}

/// Pressed-in dots, like the grip on a slide projector's controls (`.ss-dimpled`).
struct Dimples: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        var y: CGFloat = 3
        var row = 0
        while y < r.height {
            var x: CGFloat = row % 2 == 0 ? 3 : 8.6
            while x < r.width { p.addEllipse(in: CGRect(x: x, y: y, width: 1.6, height: 1.6)); x += 11.3 }
            y += 5.6; row += 1
        }
        return p
    }
}

struct PressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.offset(y: configuration.isPressed ? 1 : 0).brightness(configuration.isPressed ? -0.03 : 0)
    }
}

/// The slide's own date (or where its estimate comes from) and its caption.
struct MetaFields: View {
    @Environment(AppModel.self) private var model
    let slide: Slide
    let estimated: SlideDate
    @State private var date = ""
    @State private var caption = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            field("Date") {
                TextField(estimated.value.isEmpty ? "1978-08" : estimated.value, text: $date).keyboardType(.numbersAndPunctuation)
                    .onChange(of: date) { _, v in if v != (slide.date ?? "") { model.setDate(v) } }
            }
            if slide.date == nil, !estimated.value.isEmpty {
                Text(estimated.source == .between ? "Estimated between the dated slides around it" : estimated.source == .near ? "From the nearest dated slide" : "The tray's date")
                    .font(.system(size: 10)).foregroundStyle(ProTheme.dim)
            }
            field("Caption") {
                TextField("Immich description", text: $caption, axis: .vertical).lineLimit(1...4)
                    .onChange(of: caption) { _, v in if v != (slide.caption ?? "") { model.setCaption(v) } }
            }
        }
        .padding(12)
        .task(id: slide.id) { date = slide.date ?? ""; caption = slide.caption ?? "" }
    }

    private func field<C: View>(_ label: String, @ViewBuilder _ c: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.system(size: 11)).foregroundStyle(ProTheme.muted)
            c().textFieldStyle(.plain).font(.system(size: 12))
                .padding(.horizontal, 8).padding(.vertical, 6)
                .background(SS.field, in: RoundedRectangle(cornerRadius: 5))
                .overlay { RoundedRectangle(cornerRadius: 5).strokeBorder(ProTheme.line, lineWidth: 1) }
        }
    }
}

/// The tray's name (the Immich album) and date, and what has been learned.
struct TrayFields: View {
    @Environment(AppModel.self) private var model
    let tray: Tray
    @State private var name = ""
    @State private var album = ""
    @State private var date = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            row("Name", $name); row("Album", $album); row("Date", $date)
            if model.learningEnabled {
                Text(model.learning.ready ? "Learned from \(model.learning.examples.count) developed slides" : "Learning starts after 5 developed slides (\(model.learning.examples.count) so far)")
                    .font(.system(size: 11)).foregroundStyle(ProTheme.dim)
            }
        }
        .padding(12)
        .task(id: tray.id) { name = tray.name; album = tray.album; date = tray.date }
        .onSubmit { model.rename(name, album: album.isEmpty ? name : album, date: SlideDates.parse(date) == nil ? "" : date) }
    }

    private func row(_ label: String, _ text: Binding<String>) -> some View {
        HStack {
            Text(label).font(.system(size: 11)).foregroundStyle(ProTheme.muted).frame(width: 46, alignment: .leading)
            TextField(label, text: text).textFieldStyle(.plain).font(.system(size: 12))
                .padding(.horizontal, 8).padding(.vertical, 5)
                .background(SS.field, in: RoundedRectangle(cornerRadius: 5))
                .overlay { RoundedRectangle(cornerRadius: 5).strokeBorder(ProTheme.line, lineWidth: 1) }
        }
    }
}
