import ProUI
import SlideKit
import SwiftUI

/// Studio mode (iPad, regular width): the web app's layout on ProUI — top bar, filmstrip of slide
/// mounts | stage | inspector, status bar — for trackpad, pencil and hardware keyboard. Same keys:
/// ← → move, Space develops, R / ⇧R turn, X skips, B before, Y split, K crop, W neutral,
/// F / ⇧F fit curves, ⌘Z / ⇧⌘Z undo, 1–9 toggle bracket scans.
struct StudioView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("studio") private var studio = false
    @AppStorage("showFilmstrip") private var showFilmstrip = true
    @AppStorage("showInspector") private var showInspector = true
    @State private var before = false
    @State private var split = false
    @State private var picking = false
    @State private var cropping = false
    @State private var cropRect = CropMath.full
    @State private var cropAspect = "Free"
    @State private var cropRatio: Double?
    @State private var cropPortrait = false
    @State private var cropStart: (rect: [Double]?, angle: Double)?
    @State private var settings = false

    var body: some View {
        if let tray = model.tray {
            VStack(spacing: 0) {
                StudioTopBar(tray: tray, showFilmstrip: $showFilmstrip, showInspector: $showInspector, settings: $settings)
                HStack(spacing: 0) {
                    if showFilmstrip {
                        FilmstripPanel(tray: tray).frame(width: 268)
                        Rectangle().fill(ProTheme.seam).frame(width: 1)
                    }
                    stage(tray)
                    if showInspector {
                        Rectangle().fill(ProTheme.seam).frame(width: 1)
                        InspectorPanel(tray: tray, picking: $picking, cropping: cropping, onCrop: toggleCrop).frame(width: 312)
                    }
                }
                statusbar(tray)
            }
            .background(ProTheme.background)
            .background { shortcuts }
            .sheet(isPresented: $settings) { SettingsView() }
            .onChange(of: model.selection) { _, _ in cropping = false; picking = false }   // a draft crop belongs to the slide it was drawn on
        }
    }

    // MARK: stage

    private func stage(_ tray: Tray) -> some View {
        VStack(spacing: 0) {
            stageBar(tray)
            ZStack {
                SS.sunken
                if let slide = model.slide {
                    StagePhoto(tray: tray, slide: slide, before: before, split: split && !cropping, cropping: cropping,
                               picking: $picking, cropRect: $cropRect, cropRatio: cropRatio)
                        .padding(28)
                    if picking {
                        Text("Tap something that should be neutral grey or white").font(.system(size: 12, weight: .medium))
                            .padding(.horizontal, 12).padding(.vertical, 6).background(.black.opacity(0.7), in: Capsule())
                            .frame(maxHeight: .infinity, alignment: .top).padding(.top, 10)
                    }
                } else {
                    FinishLine(tray: tray)
                }
            }
            if let slide = model.slide {
                if cropping {
                    CropBar(rect: $cropRect, aspect: $cropAspect, ratio: $cropRatio, portrait: $cropPortrait, frame: frameAspect(tray, slide),
                            angle: slide.params.angle, onAngle: { model.setFrame(crop: slide.params.crop, angle: $0) },
                            onCancel: cancelCrop, onDone: finishCrop)
                } else {
                    ScanStrip(tray: tray, slide: slide)
                }
            }
        }
        .frame(minWidth: 0, maxWidth: .infinity)
        .layoutPriority(-1)   // the side panels keep their width; the stage takes what's left
    }

    private func stageBar(_ tray: Tray) -> some View {
        HStack(spacing: 8) {
            if model.selection < tray.groups.count {
                (Text("\(model.selection + 1)").foregroundStyle(ProTheme.ink) + Text(" / \(tray.groups.count)").foregroundStyle(ProTheme.dim))
                    .font(.system(size: 12, weight: .medium).monospacedDigit())
            }
            Spacer()
            if let slide = model.slide {
                let st = model.statuses[model.selection]
                HStack(spacing: 6) {
                    Circle().fill(st.dotFill).frame(width: 7, height: 7).overlay { Circle().strokeBorder(st == .skipped ? Color(proHex: 0x666666) : .clear, lineWidth: 1) }
                    Text(st == .new ? "to develop" : st.label.lowercased())
                }
                .font(.system(size: 11)).foregroundStyle(ProTheme.muted)
                .padding(.horizontal, 9).frame(height: 22).background(SS.panel2, in: Capsule())
                ProButton(plain: true, action: model.undo) { Image(systemName: "arrow.uturn.backward") }.disabled(!slide.canUndo).accessibilityLabel("Undo")
                ProButton(plain: true, action: model.redo) { Image(systemName: "arrow.uturn.forward") }.disabled(!slide.canRedo).accessibilityLabel("Redo")
                ProButton(active: split, activeTint: SS.panel2, action: { split.toggle() }) { Image(systemName: "rectangle.split.2x1") }.accessibilityLabel("Split view")
                ProButton(active: before, activeTint: SS.panel2, action: { before.toggle() }) { Text("Before") }
            }
        }
        .padding(.horizontal, 12).frame(height: 36)
        .background(SS.bar)
        .overlay(alignment: .bottom) { Rectangle().fill(ProTheme.lineSoft).frame(height: 1) }
    }

    private func statusbar(_ tray: Tray) -> some View {
        let st = model.statuses
        let toDevelop = tray.groups.filter { !$0.developed && !$0.skip }.count
        return ProStatusbar {
            Text("\(tray.groups.count) slides")
            Text("\(toDevelop) to develop")
            Text("\(st.filter { $0 == .uploaded }.count) in Immich")
            if st.contains(.skipped) { Text("\(st.filter { $0 == .skipped }.count) skipped") }
            Spacer()
            hint("← →", "browse"); hint("Space", "develop")
        }
    }

    private func hint(_ k: String, _ what: String) -> some View {
        HStack(spacing: 4) {
            Text(k).font(.system(size: 10, weight: .medium)).padding(.horizontal, 4).frame(height: 16).background(SS.panel2, in: RoundedRectangle(cornerRadius: 3))
            Text(what)
        }
    }

    // MARK: crop

    private func frameAspect(_ tray: Tray, _ slide: Slide) -> Double {
        guard let img = model.previews.cached(slide, edge: 2000, crop: false) else { return 1.5 }
        return Double(img.size.width / img.size.height)
    }

    private func toggleCrop() { cropping ? finishCrop() : startCrop() }

    private func startCrop() {
        guard let s = model.slide, s.locked == nil else { return }
        cropStart = (s.params.crop, s.params.angle)
        cropRect = s.params.crop ?? CropMath.full
        cropAspect = "Free"; cropRatio = nil
        picking = false; split = false
        cropping = true
    }

    private func finishCrop() {
        guard cropping, let s = model.slide else { cropping = false; return }
        model.setFrame(crop: cropRect, angle: s.params.angle)
        cropping = false
    }

    private func cancelCrop() {
        if let start = cropStart, cropping, let s = model.slide, s.params.angle != start.angle || s.params.crop != start.rect {
            model.setFrame(crop: start.rect, angle: start.angle)
        }
        cropping = false
    }

    private func nudgeCrop(_ dx: Double, _ dy: Double) {
        guard cropping else { return }
        cropRect = CropMath.drag(.move, from: cropRect, dx: dx, dy: dy, ratio: nil, frame: 1)
    }

    // MARK: keys

    private var shortcuts: some View {
        Group {
            Button("") { cropping ? nudgeCrop(0.01, 0) : model.next() }.keyboardShortcut(.rightArrow, modifiers: [])
            Button("") { cropping ? nudgeCrop(-0.01, 0) : model.previous() }.keyboardShortcut(.leftArrow, modifiers: [])
            Button("") { nudgeCrop(0, -0.01) }.keyboardShortcut(.upArrow, modifiers: [])
            Button("") { nudgeCrop(0, 0.01) }.keyboardShortcut(.downArrow, modifiers: [])
            Button("") { if let s = model.slide { s.developed ? model.next() : model.keep() } }.keyboardShortcut(.space, modifiers: [])
            Button("") { model.turn() }.keyboardShortcut("r", modifiers: [])
            Button("") { model.turn(clockwise: false) }.keyboardShortcut("r", modifiers: .shift)
            Button("") { model.skip(advance: false) }.keyboardShortcut("x", modifiers: [])
            Button("") { before.toggle() }.keyboardShortcut("b", modifiers: [])
            Button("") { split.toggle() }.keyboardShortcut("y", modifiers: [])
            Button("") { toggleCrop() }.keyboardShortcut("k", modifiers: [])
            Button("") { finishCrop() }.keyboardShortcut(.return, modifiers: [])
            Button("") { if cropping { cancelCrop() } else { picking = false } }.keyboardShortcut(.escape, modifiers: [])
            Button("") { picking.toggle() }.keyboardShortcut("w", modifiers: [])
            Button("") { model.fitCurves() }.keyboardShortcut("f", modifiers: [])
            Button("") { model.fitCurves(all: true) }.keyboardShortcut("f", modifiers: .shift)
            Button("") { model.undo() }.keyboardShortcut("z", modifiers: .command)
            Button("") { model.redo() }.keyboardShortcut("z", modifiers: [.command, .shift])
            ForEach(1..<10) { n in
                Button("") { if let s = model.slide, n <= s.scans.count { model.toggleScan(s.scans[n - 1]) } }
                    .keyboardShortcut(KeyEquivalent(Character(String(n))), modifiers: [])
            }
        }
        .opacity(0).accessibilityHidden(true)
    }
}

/// The photo on the stage, like a slide on a light box: the developed picture (uncropped while
/// cropping), the untouched scan in the same frame for Before, or both at a divider for Split.
struct StagePhoto: View {
    @Environment(AppModel.self) private var model
    let tray: Tray
    let slide: Slide
    let before: Bool
    let split: Bool
    let cropping: Bool
    @Binding var picking: Bool
    @Binding var cropRect: CropMath.Rect
    let cropRatio: Double?
    @State private var main: UIImage?
    @State private var original: UIImage?
    @State private var divider = 0.5

    var body: some View {
        let mainKey = PreviewCache.key(slide, edge: 2000, before: false, crop: !cropping)
        let beforeKey = PreviewCache.key(slide, edge: 2000, before: true, crop: !cropping)
        ZStack {
            if let img = shownMain {
                Image(uiImage: (before && !split ? shownBefore : nil) ?? img).resizable().aspectRatio(contentMode: .fit)
                    .overlay { if split, let o = shownBefore { splitLayer(o) } }
                    .overlay {
                        if cropping { CropOverlay(rect: $cropRect, ratio: cropRatio, frame: Double(img.size.width / img.size.height)) }
                        else if picking { pickLayer }
                    }
                    .shadow(color: .black.opacity(cropping ? 0 : 0.65), radius: 14, y: 12)
            } else {
                ProgressView().tint(ProTheme.muted)
            }
        }
        .task(id: mainKey) {
            if model.previews.cached(slide, edge: 2000, crop: !cropping) == nil { try? await Task.sleep(for: .milliseconds(40)) }
            guard !Task.isCancelled else { return }
            if let i = await model.previews.image(tray, slide, edge: 2000, crop: !cropping), !Task.isCancelled { main = i }
        }
        .task(id: (before || split) ? beforeKey : "") {
            guard before || split else { return }
            if let i = await model.previews.image(tray, slide, edge: 2000, before: true, crop: !cropping), !Task.isCancelled { original = i }
        }
    }

    private var shownMain: UIImage? { model.previews.cached(slide, edge: 2000, crop: !cropping) ?? main }
    private var shownBefore: UIImage? { model.previews.cached(slide, edge: 2000, before: true, crop: !cropping) ?? original }

    /// Before on the left of a draggable divider, after on the right; they line up pixel for pixel.
    private func splitLayer(_ o: UIImage) -> some View {
        GeometryReader { g in
            let x = g.size.width * divider
            Image(uiImage: o).resizable().aspectRatio(contentMode: .fit)
                .mask(alignment: .leading) { Rectangle().frame(width: x) }
            Rectangle().fill(.white).frame(width: 2).shadow(color: .black.opacity(0.6), radius: 2).position(x: x, y: g.size.height / 2)
            Circle().fill(.white).frame(width: 22, height: 22).shadow(color: .black.opacity(0.5), radius: 3)
                .overlay { Image(systemName: "arrow.left.and.right").font(.system(size: 10, weight: .bold)).foregroundStyle(.black) }
                .position(x: x, y: g.size.height / 2)
            HStack { tag("Before"); Spacer(); tag("After") }.padding(8)
        }
        .overlay { GeometryReader { g in Color.clear.contentShape(Rectangle()).gesture(DragGesture(minimumDistance: 0).onChanged { v in divider = min(1, max(0, v.location.x / g.size.width)) }) } }
    }

    private func tag(_ t: String) -> some View {
        Text(t.uppercased()).font(.system(size: 10, weight: .semibold)).tracking(0.8).padding(.horizontal, 6).padding(.vertical, 3).background(.black.opacity(0.6))
    }

    private var pickLayer: some View {
        GeometryReader { g in
            Color.clear.contentShape(Rectangle())
                .onTapGesture { p in
                    model.neutral(at: CGPoint(x: p.x / g.size.width, y: p.y / g.size.height))
                    picking = false
                }
        }
    }
}

/// The scans in the bracket, each switchable (1–9); best-of-bracket's picks are marked.
struct ScanStrip: View {
    @Environment(AppModel.self) private var model
    let tray: Tray
    let slide: Slide

    var body: some View {
        HStack(spacing: 10) {
            Text(slide.scans.count > 1 ? "HDR ×\(slide.activeScans.count)" : "Single scan").font(.system(size: 11)).foregroundStyle(ProTheme.muted)
            ForEach(Array(slide.scans.enumerated()), id: \.element) { i, scan in
                let on = slide.activeScans.contains(scan)
                Button { model.toggleScan(scan) } label: {
                    AsyncThumb(url: model.renderer.thumbURL(tray.id, scan), rotation: slide.rotation)
                        .frame(width: 56, height: 38).clipShape(RoundedRectangle(cornerRadius: 3))
                        .overlay { RoundedRectangle(cornerRadius: 3).strokeBorder(on ? ProTheme.accent.opacity(slide.scans.count > 1 ? 1 : 0) : ProTheme.line, lineWidth: on ? 1.5 : 1) }
                        .overlay(alignment: .topLeading) {
                            Text("\(i + 1)").font(.system(size: 9, weight: .semibold)).padding(.horizontal, 3).background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 2)).padding(2)
                        }
                        .overlay(alignment: .bottom) {
                            if let why = slide.autoExcluded?[scan] { Text(why).font(.system(size: 8, weight: .semibold)).padding(.horizontal, 3).background(.black.opacity(0.7)).padding(.bottom, 2) }
                        }
                        .opacity(on ? 1 : 0.35)
                }
                .buttonStyle(.plain).disabled(slide.scans.count < 2)
                .accessibilityLabel("Scan \(i + 1), \(on ? "in" : "left out")")
            }
            Spacer()
        }
        .padding(.horizontal, 14).frame(height: 64)
        .background(SS.bar)
        .overlay(alignment: .top) { Rectangle().fill(ProTheme.lineSoft).frame(height: 1) }
    }
}

struct AsyncThumb: View {
    let url: URL
    var rotation = 0
    @State private var image: UIImage?
    var body: some View {
        ZStack { if let image { Image(uiImage: image).resizable().scaledToFill().rotationEffect(.degrees(Double(rotation))) } else { SS.sunken } }
            .task(id: url) { image = await Task.detached { UIImage(contentsOfFile: url.path) }.value }
    }
}

/// The web app's top bar: app mark, tray switcher, the scanner pill, panel toggles.
struct StudioTopBar: View {
    @Environment(AppModel.self) private var model
    @AppStorage("studio") private var studio = false
    let tray: Tray
    @Binding var showFilmstrip: Bool
    @Binding var showInspector: Bool
    @Binding var settings: Bool

    var body: some View {
        ProToolbar {
            Button { model.close() } label: {
                HStack(spacing: 7) {
                    Image("Mark").resizable().frame(width: 20, height: 20).clipShape(RoundedRectangle(cornerRadius: 5))
                    Text("Slide Station").font(.system(size: 13, weight: .semibold)).foregroundStyle(ProTheme.ink)
                }
            }.buttonStyle(.plain).accessibilityLabel("All trays")
            Rectangle().fill(ProTheme.line).frame(width: 1, height: 20).padding(.horizontal, 4)
            Menu {
                ForEach(model.trays) { t in
                    Button { Task { await model.open(t.id) } } label: { Label("\(t.name) · \(t.groups.count) slides", systemImage: t.id == tray.id ? "checkmark" : "") }
                }
            } label: {
                HStack(spacing: 6) {
                    Text("\(tray.name) · \(tray.groups.count) slides").font(.system(size: 12))
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(ProTheme.muted)
                }
                .foregroundStyle(ProTheme.ink).padding(.horizontal, 10).frame(height: 25)
                .background(SS.field, in: RoundedRectangle(cornerRadius: 5))
                .overlay { RoundedRectangle(cornerRadius: 5).strokeBorder(ProTheme.line, lineWidth: 1) }
            }
            Spacer()
            scannerPill
            Spacer()
            ProButton(plain: true, action: { withAnimation(.snappy) { showFilmstrip.toggle() } }) { Image(systemName: "sidebar.left") }
                .accessibilityLabel(showFilmstrip ? "Hide filmstrip" : "Show filmstrip")
            ProButton(plain: true, action: { withAnimation(.snappy) { showInspector.toggle() } }) { Image(systemName: "sidebar.right") }
                .accessibilityLabel(showInspector ? "Hide inspector" : "Show inspector")
            ProButton("Simple", action: { studio = false })
            ProButton(plain: true, action: { settings = true }) { Image(systemName: "gearshape") }.accessibilityLabel("Settings")
        }
        .font(.system(size: 12))
        .foregroundStyle(ProTheme.ink)
    }

    /// Green once the scanner is there, like the first version's chip.
    @ViewBuilder private var scannerPill: some View {
        if let job = model.job {
            HStack(spacing: 8) {
                ProgressView(value: job.total > 0 ? job.fraction : nil).tint(ProTheme.accent).frame(width: 60)
                Text(job.message).lineLimit(1)
            }
            .padding(.horizontal, 12).frame(height: 26).background(SS.field, in: Capsule())
            .overlay { Capsule().strokeBorder(ProTheme.line, lineWidth: 1) }
        } else if let card = model.card {
            HStack(spacing: 8) {
                Circle().fill(ProTheme.green).frame(width: 7, height: 7)
                Text(card.scanner ? "Slide N Scan" : card.name).foregroundStyle(ProTheme.ink)
                Text("·").foregroundStyle(ProTheme.dim)
                Text(card.new > 0 ? "\(card.new) new" : "nothing new").foregroundStyle(ProTheme.muted)
                if card.new > 0 {
                    Button("Import") { model.importFromCard(name: tray.name, date: tray.date, into: tray.id) }
                        .font(.system(size: 11, weight: .semibold)).foregroundStyle(ProTheme.accent)
                }
            }
            .padding(.horizontal, 12).frame(height: 26)
            .background(ProTheme.green.opacity(0.12), in: Capsule())
            .overlay { Capsule().strokeBorder(ProTheme.green.opacity(0.35), lineWidth: 1) }
        } else {
            HStack(spacing: 8) { Circle().fill(ProTheme.dim).frame(width: 7, height: 7); Text("No scanner").foregroundStyle(ProTheme.muted) }
                .padding(.horizontal, 12).frame(height: 26).background(SS.field, in: Capsule())
        }
    }
}
