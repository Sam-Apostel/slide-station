import ProUI
import SlideKit
import SwiftUI

/// A phone's tools (`components/compact.tsx`): the inspector's sections one at a time, plus the
/// slides (the filmstrip with its filters) and the scans stacked into the slide.
enum CompactTool: String, CaseIterable, Identifiable {
    case slides, frame, adjust, curve, scans, details, tray
    var id: String { rawValue }
    var label: String {
        switch self {
        case .slides: "Slides"
        case .frame: "Frame"
        case .adjust: "Adjust"
        case .curve: "Curve"
        case .scans: "Scans"
        case .details: "Details"
        case .tray: "Tray"
        }
    }
    var icon: String {
        switch self {
        case .slides: "photo.on.rectangle"
        case .frame: "crop"
        case .adjust: "slider.horizontal.3"
        case .curve: "chart.line.uptrend.xyaxis"
        case .scans: "square.3.layers.3d"
        case .details: "calendar"
        case .tray: "tray"
        }
    }
    /// Tools that change the photo: not for a locked slide.
    var edits: Bool { [.frame, .adjust, .curve, .scans].contains(self) }
}

/// Studio on a phone (or any compact width), the web app's phone layouts:
///
/// - **Upright**: the photo on top (swipe for the next or previous slide, double-tap to zoom,
///   long-press for the slide menu), under it the row of the tray's slides or the open tool's
///   panel, a row of tools, and a bar with what every slide gets: ‹ Skip Turn Develop.
/// - **On its side**: the photo full height, the open tool's panel beside it, the tools in a rail
///   at the edge with Develop at the bottom, where the thumb rests.
///
/// Crop takes the whole screen. The tools are the same views as Studio's inspector.
struct CompactStudioView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("studio") private var studio = Platform.studioDefault
    let landscape: Bool
    @State private var tool: CompactTool?
    @State private var tall = false
    @State private var picking = false
    @State private var before = false
    @State private var crop = CropDraft()
    @State private var settings = false

    var body: some View {
        if let tray = model.tray {
            Group {
                if landscape { sideways(tray) } else { upright(tray) }
            }
            .background(ProTheme.background.ignoresSafeArea())
            .foregroundStyle(ProTheme.ink)
            .sheet(isPresented: $settings) { SettingsView() }
            .onChange(of: model.selection) { _, _ in crop.on = false; picking = false; before = false }
            .onChange(of: tool) { _, t in if t != .adjust { picking = false } }
            .animation(.snappy(duration: 0.25), value: tool)
            .animation(.snappy(duration: 0.25), value: crop.on)
            #if DEBUG
            .onAppear { if let t = DebugLaunch.env["SS_TOOL"].flatMap(CompactTool.init(rawValue:)) { tool = t } }
            #endif
        }
    }

    // MARK: upright

    private func upright(_ tray: Tray) -> some View {
        VStack(spacing: 0) {
            if !crop.on { header(tray) }
            stage(tray)
                .frame(minHeight: 180)
                .layoutPriority(1)
            if crop.on, let s = model.slide {
                cropBar(tray, s).background(SS.bar.ignoresSafeArea(edges: .bottom))
            } else {
                if let tool { panel(tool, tray).frame(height: tall ? 470 : 300) } else { SlideRow(tray: tray).frame(height: 92) }
                toolRow
                if let g = model.slide { bottomBar(g) }
            }
        }
    }

    private func header(_ tray: Tray) -> some View {
        HStack(spacing: 6) {
            Button { model.close() } label: { Image(systemName: "chevron.left").font(.system(size: 17, weight: .semibold)).frame(width: 40, height: 44) }
                .accessibilityLabel("All trays")
            Button { toggle(.tray) } label: {
                HStack(spacing: 5) {
                    Text(tray.name).font(.system(size: 16, weight: .semibold)).lineLimit(1)
                    Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(ProTheme.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Tray: \(tray.name). Trays, upload and the card")
            if model.job != nil { ProgressView().tint(ProTheme.muted).padding(.horizontal, 4) }
            Button { settings = true } label: { Image(systemName: "gearshape").font(.system(size: 17)).frame(width: 44, height: 44) }
                .foregroundStyle(ProTheme.muted).accessibilityLabel("Settings")
        }
        .padding(.leading, 4).padding(.trailing, 4)
        .frame(height: 48)
        .background(SS.bar.ignoresSafeArea(edges: .top))
        .overlay(alignment: .bottom) { Rectangle().fill(ProTheme.line).frame(height: 1) }
        .foregroundStyle(ProTheme.ink)
    }

    /// Every tool in view, an equal share of the width each (no row scrolled out of sight).
    private var toolRow: some View {
        HStack(spacing: 2) {
            ForEach(CompactTool.allCases) { t in ToolButton(tool: t, active: tool == t, fill: true) { toggle(t) } }
        }
        .padding(.horizontal, 4).padding(.vertical, 4)
        .background(SS.bar)
        .overlay(alignment: .top) { Rectangle().fill(ProTheme.line).frame(height: 1) }
    }

    private func bottomBar(_ g: Slide) -> some View {
        HStack(spacing: 8) {
            BarButton(icon: "chevron.left", label: "Previous slide") { model.previous() }.disabled(model.selection == 0)
            skipButton(g)
            turnButton(g)
            DevelopButton(done: g.developed, compact: true) { g.developed ? model.nextUndeveloped() : model.keep() }
        }
        .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 4)
        .background(ProTheme.panel.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Rectangle().fill(ProTheme.line).frame(height: 1) }
    }

    // MARK: on its side

    private func sideways(_ tray: Tray) -> some View {
        // each column's colour runs to the screen's edges: the layout takes the whole width and
        // pads the content by the insets itself (the Dynamic Island side, the other side)
        GeometryReader { geo in
            let inset = geo.safeAreaInsets
            HStack(spacing: 0) {
                VStack(spacing: 0) {
                    stage(tray)
                    if crop.on, let s = model.slide { cropBar(tray, s) }
                }
                .padding(.leading, inset.leading)
                .padding(.trailing, crop.on ? inset.trailing : 0)
                .background(SS.sunken.ignoresSafeArea(edges: .vertical))
                if !crop.on {
                    if let tool {
                        seam
                        panel(tool, tray).frame(width: 340)
                    }
                    seam
                    rail(tray)
                        .padding(.trailing, inset.trailing)
                        .background(SS.bar.ignoresSafeArea(edges: .vertical))
                }
            }
            .ignoresSafeArea(edges: .horizontal)
        }
    }

    private var seam: some View { Rectangle().fill(ProTheme.line).frame(width: 1).ignoresSafeArea(edges: .vertical) }

    /// Back and Settings, the tools two by two (all seven fit a phone's height), Skip and Turn,
    /// and Develop where the thumb rests.
    private func rail(_ tray: Tray) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                Button { model.close() } label: { Image(systemName: "chevron.left").frame(width: 36, height: 36) }.accessibilityLabel("All trays")
                Button { settings = true } label: { Image(systemName: "gearshape").frame(width: 36, height: 36) }
                    .foregroundStyle(ProTheme.muted).accessibilityLabel("Settings")
            }
            .font(.system(size: 15, weight: .semibold))
            .padding(.vertical, 2)
            Rectangle().fill(ProTheme.line).frame(height: 1)
            ScrollView(showsIndicators: false) {
                LazyVGrid(columns: [GridItem(.fixed(48), spacing: 2), GridItem(.fixed(48), spacing: 2)], spacing: 2) {
                    ForEach(CompactTool.allCases) { t in ToolButton(tool: t, active: tool == t, narrow: true) { toggle(t) } }
                }
                .padding(.vertical, 6)
            }
            .scrollBounceBehavior(.basedOnSize)
            if let g = model.slide {
                Rectangle().fill(ProTheme.line).frame(height: 1)
                VStack(spacing: 6) {
                    HStack(spacing: 6) { skipButton(g); turnButton(g) }
                    DevelopButton(done: g.developed, compact: true, square: true) { g.developed ? model.nextUndeveloped() : model.keep() }
                }
                .padding(.horizontal, 6).padding(.vertical, 8)
            }
        }
        .frame(width: 106)
    }

    // MARK: shared pieces

    private func toggle(_ t: CompactTool) { tool = tool == t ? nil : t }

    private func skipButton(_ g: Slide) -> some View {
        BarButton(icon: "forward.end", label: g.skip ? "Don't skip" : "Skip slide", active: g.skip) { model.skip(advance: false) }
    }

    private func turnButton(_ g: Slide) -> some View {
        BarButton(icon: "rotate.right", label: "Rotate right") { withAnimation(.snappy) { model.turn() } }.disabled(g.locked != nil)
    }

    private func stage(_ tray: Tray) -> some View {
        CompactStage(tray: tray, before: $before, picking: $picking, crop: $crop)
    }

    private func cropBar(_ tray: Tray, _ s: Slide) -> some View {
        CropBar(rect: $crop.rect, aspect: $crop.aspect, ratio: $crop.ratio, portrait: $crop.portrait,
                frame: model.previews.cached(s, edge: 2000, crop: false)?.aspect ?? 1.5,
                angle: s.params.angle, onAngle: { model.setFrame(crop: s.params.crop, angle: $0) },
                onCancel: { crop.cancel(model) }, onDone: { crop.finish(model) })
    }

    /// The open tool's panel: its name (upright: tap it for a taller panel) and a close button over
    /// the tool's own view.
    private func panel(_ t: CompactTool, _ tray: Tray) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Button { if !landscape { tall.toggle() } } label: {
                    HStack(spacing: 5) {
                        Text(t.label).font(.system(size: 14, weight: .semibold))
                        if !landscape { Image(systemName: tall ? "chevron.down" : "chevron.up").font(.system(size: 10, weight: .semibold)).foregroundStyle(ProTheme.muted) }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(landscape ? t.label : tall ? "Make the panel smaller" : "Make the panel taller")
                if t == .adjust, let g = model.slide, g.locked == nil {
                    AdjustActions(slide: g).buttonStyle(.plain).foregroundStyle(ProTheme.muted).font(.system(size: 14))
                        .frame(height: 36).padding(.horizontal, 6)
                }
                Button { tool = nil } label: { Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)).frame(width: 36, height: 36) }
                    .foregroundStyle(ProTheme.muted).accessibilityLabel("Close")
            }
            .padding(.leading, 14).padding(.trailing, 4)
            .frame(height: 40)
            .overlay(alignment: .bottom) { Rectangle().fill(ProTheme.lineSoft).frame(height: 1) }
            toolBody(t, tray)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .background(ProTheme.panel.ignoresSafeArea(edges: landscape ? [.top, .bottom] : []))
        .overlay(alignment: .top) { if !landscape { Rectangle().fill(ProTheme.line).frame(height: 1) } }
        .font(.system(size: 14))
    }

    @ViewBuilder private func toolBody(_ t: CompactTool, _ tray: Tray) -> some View {
        switch t {
        case .slides:
            FilmstripPanel(tray: tray)
        case .tray:
            ScrollView { TrayTool(tray: tray, onStudioOff: { studio = false }) }
        default:
            if let g = model.slide {
                ScrollView {
                    VStack(spacing: 0) {
                        if g.locked != nil && t.edits { LockedBanner() }
                        Group {
                            switch t {
                            case .frame: FrameSection(slide: g, cropping: crop.on, onCrop: { crop.begin(g); tool = nil; picking = false })
                            case .adjust: AdjustPanel(tray: tray, slide: g, picking: $picking)
                            case .curve: CurveSection(tray: tray, slide: g)
                            case .scans: ScansTool(tray: tray, slide: g)
                            case .details: MetaFields(slide: g, estimated: SlideDates.estimate(tray)[model.selection])
                            default: EmptyView()
                            }
                        }
                        .disabled(g.locked != nil && t.edits)
                        .opacity(g.locked != nil && t.edits ? 0.55 : 1)
                    }
                }
                .scrollDismissesKeyboard(.interactively)
            } else {
                Text("Pick a slide to use \(t.label).").foregroundStyle(ProTheme.muted).padding(20)
            }
        }
    }
}

// MARK: - the photo

/// The photo on a phone: the stage of Studio without the side panels. Swipe for the next or
/// previous slide, double-tap to zoom in where you tapped (drag to look around), long-press for
/// the slide menu. While cropping it's the crop tool; while picking, the eyedropper.
struct CompactStage: View {
    @Environment(AppModel.self) private var model
    let tray: Tray
    @Binding var before: Bool
    @Binding var picking: Bool
    @Binding var crop: CropDraft
    @State private var swipe: CGFloat = 0
    @State private var zoom: CGFloat = 1
    @State private var anchor: UnitPoint = .center
    @State private var pan: CGSize = .zero
    @State private var panStart: CGSize = .zero

    var body: some View {
        ZStack {
            SS.sunken
            if let slide = model.slide {
                GeometryReader { geo in
                    StagePhoto(tray: tray, slide: slide, before: before, split: false, cropping: crop.on,
                               picking: $picking, cropRect: $crop.rect, cropRatio: crop.ratio)
                        // the top band holds the pills, so they never sit on the photo
                        .padding(.top, crop.on ? 20 : 48).padding([.horizontal, .bottom], crop.on ? 20 : 10)
                        .scaleEffect(zoom, anchor: anchor)
                        .offset(x: swipe + pan.width, y: pan.height)
                        .frame(width: geo.size.width, height: geo.size.height)
                        .contentShape(Rectangle())
                        .gesture(crop.on || picking ? nil : gestures(geo.size))
                        .contextMenu { if !crop.on { menu(slide) } }
                }
                .clipped()
                if !crop.on { overlay(slide) }
                if picking {
                    Text("Tap something that should be neutral grey or white").font(.system(size: 12, weight: .medium))
                        .padding(.horizontal, 12).padding(.vertical, 6).background(.black.opacity(0.7), in: Capsule())
                        .frame(maxHeight: .infinity, alignment: .bottom).padding(.bottom, 10)
                }
            } else {
                ScrollView { FinishLine(tray: tray).frame(minHeight: 420) }
            }
        }
        .onChange(of: model.selection) { _, _ in zoom = 1; pan = .zero; panStart = .zero }
    }

    private func gestures(_ size: CGSize) -> some Gesture {
        let drag = DragGesture(minimumDistance: 16)
            .onChanged { v in
                if zoom > 1 { pan = CGSize(width: panStart.width + v.translation.width, height: panStart.height + v.translation.height) }
                else if abs(v.translation.width) > abs(v.translation.height) { swipe = v.translation.width }
            }
            .onEnded { v in
                if zoom > 1 { panStart = pan; return }
                let x = v.predictedEndTranslation.width
                withAnimation(.snappy) { swipe = 0 }
                if x < -size.width * 0.3 { model.next() } else if x > size.width * 0.3 { model.previous() }
            }
        let doubleTap = SpatialTapGesture(count: 2).onEnded { t in
            withAnimation(.snappy) {
                if zoom > 1 { zoom = 1; pan = .zero; panStart = .zero } else {
                    anchor = UnitPoint(x: t.location.x / max(1, size.width), y: t.location.y / max(1, size.height))
                    zoom = 2.5
                }
            }
        }
        return doubleTap.simultaneously(with: drag)
    }

    @ViewBuilder private func menu(_ g: Slide) -> some View {
        if !(g.developed && g.immich != nil) {
            Button(g.reviewed ? "Not developed" : "Develop", systemImage: "checkmark") { model.toggleDeveloped() }
        }
        Button(g.skip ? "Don't skip" : "Skip", systemImage: "xmark") { model.skip(advance: false) }
        Button("Rotate right", systemImage: "rotate.right") { model.turn() }
        Button("Rotate left", systemImage: "rotate.left") { model.turn(clockwise: false) }
        Button("Next slide to develop", systemImage: "forward.end") { model.nextUndeveloped() }
    }

    /// Where you are and what you can take back: "12 / 36", the status, undo / redo, Before.
    private func overlay(_ slide: Slide) -> some View {
        let st = tray.statuses().indices.contains(model.selection) ? tray.statuses()[model.selection] : .new
        return VStack {
            HStack(spacing: 6) {
                HStack(spacing: 6) {
                    Circle().fill(st.dotFill).frame(width: 7, height: 7)
                        .overlay { Circle().strokeBorder(st == .skipped ? Color(proHex: 0x666666) : .clear, lineWidth: 1) }
                    (Text("\(model.selection + 1)") + Text(" / \(tray.groups.count)").foregroundStyle(ProTheme.muted))
                        .font(.system(size: 12, weight: .medium).monospacedDigit())
                }
                .padding(.horizontal, 10).frame(height: 30).background(.black.opacity(0.55), in: Capsule())
                Spacer()
                pill("arrow.uturn.backward", "Undo", disabled: !slide.canUndo, action: model.undo)
                pill("arrow.uturn.forward", "Redo", disabled: !slide.canRedo, action: model.redo)
                Button { before.toggle() } label: {
                    Text("Before").font(.system(size: 12, weight: .semibold)).padding(.horizontal, 11).frame(height: 30)
                        .foregroundStyle(before ? ProTheme.accentInk : ProTheme.ink)
                        .background(before ? AnyShapeStyle(ProTheme.accent) : AnyShapeStyle(Color.black.opacity(0.55)), in: Capsule())
                }
                .buttonStyle(.plain).accessibilityAddTraits(before ? .isSelected : [])
            }
            .padding(8)
            Spacer()
        }
    }

    private func pill(_ icon: String, _ label: String, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon).font(.system(size: 12, weight: .semibold)).frame(width: 30, height: 30)
                .background(.black.opacity(0.55), in: Circle())
        }
        .buttonStyle(.plain).disabled(disabled).opacity(disabled ? 0.4 : 1).accessibilityLabel(label)
    }
}

/// The tray's slides in a row under the photo, the current one kept in view.
struct SlideRow: View {
    @Environment(AppModel.self) private var model
    let tray: Tray

    var body: some View {
        // from the tray drawn here: model.statuses is already empty while this goes away (closing the tray)
        let statuses = tray.statuses()
        let dates = SlideDates.estimate(tray)
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 10) {
                    ForEach(Array(tray.groups.enumerated()), id: \.element.id) { i, g in
                        Button { model.select(i) } label: {
                            MountTile(tray: tray, slide: g, index: i, status: statuses[i], date: dates[i], current: i == model.selection)
                                .frame(width: 72, height: 72)
                        }
                        .buttonStyle(.plain).id(g.id)
                        .accessibilityLabel("Slide \(i + 1), \(statuses[i].label)")
                        .accessibilityAddTraits(i == model.selection ? .isSelected : [])
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 10)
            }
            .onChange(of: model.selection, initial: true) { _, i in
                if tray.groups.indices.contains(i) { withAnimation(.snappy) { proxy.scrollTo(tray.groups[i].id, anchor: .center) } }
            }
        }
        .background(ProTheme.canvas)
        .overlay(alignment: .top) { Rectangle().fill(ProTheme.line).frame(height: 1) }
    }
}

/// The scans stacked into this slide, big enough to tap: leave one out of the blend or put it back.
struct ScansTool: View {
    @Environment(AppModel.self) private var model
    let tray: Tray
    let slide: Slide

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(slide.scans.count > 1 ? "Blended from \(slide.activeScans.count) of \(slide.scans.count) scans. Tap a scan to leave it out or put it back." : "One scan: nothing to blend.")
                .font(.system(size: 13)).foregroundStyle(ProTheme.muted).fixedSize(horizontal: false, vertical: true)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 10)], spacing: 10) {
                ForEach(Array(slide.scans.enumerated()), id: \.element) { i, scan in
                    let on = slide.activeScans.contains(scan)
                    Button { model.toggleScan(scan) } label: {
                        AsyncThumb(url: model.renderer.thumbURL(tray.id, scan), rotation: slide.rotation)
                            .aspectRatio(1.5, contentMode: .fit)
                            .clipShape(RoundedRectangle(cornerRadius: 5))
                            .overlay { RoundedRectangle(cornerRadius: 5).strokeBorder(on && slide.scans.count > 1 ? ProTheme.accent : ProTheme.line, lineWidth: on ? 2 : 1) }
                            .overlay(alignment: .topLeading) {
                                Text("\(i + 1)").font(.system(size: 11, weight: .semibold)).padding(.horizontal, 5).padding(.vertical, 1)
                                    .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 3)).padding(4)
                            }
                            .overlay(alignment: .bottom) {
                                if let why = slide.autoExcluded?[scan] {
                                    Text(why).font(.system(size: 10, weight: .semibold)).padding(.horizontal, 4).background(.black.opacity(0.7)).padding(.bottom, 4)
                                }
                            }
                            .opacity(on ? 1 : 0.35)
                    }
                    .buttonStyle(.plain).disabled(slide.scans.count < 2)
                    .accessibilityLabel("Scan \(i + 1), \(on ? "in" : "left out")")
                }
            }
        }
        .padding(14)
    }
}

/// The Tray tool: switch trays, import new scans, upload, clean the card, and the tray's fields.
struct TrayTool: View {
    @Environment(AppModel.self) private var model
    let tray: Tray
    let onStudioOff: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Menu {
                ForEach(model.trays) { t in
                    Button { Task { await model.open(t.id) } } label: { Label("\(t.name) · \(t.groups.count) slides", systemImage: t.id == tray.id ? "checkmark" : "") }
                }
                Divider()
                Button("All trays", systemImage: "square.grid.2x2") { model.close() }
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(tray.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(ProTheme.ink)
                        Text("\(tray.groups.count) slides · \(tray.scans.count) scans").font(.system(size: 12)).foregroundStyle(ProTheme.muted)
                    }
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down").font(.system(size: 12, weight: .semibold)).foregroundStyle(ProTheme.muted)
                }
                .padding(12).background(SS.field, in: RoundedRectangle(cornerRadius: 8))
                .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(ProTheme.line, lineWidth: 1) }
            }
            if let card = model.card, card.new > 0 {
                Button { model.importFromCard(name: tray.name, date: tray.date, into: tray.id) } label: {
                    Label("Import \(card.new) new scans into this tray", systemImage: "square.and.arrow.down")
                }
                .buttonStyle(BigButtonStyle()).disabled(model.busy)
            }
            UploadControls(tray: tray)
            TrayFields(tray: tray).padding(-12)
            Button("Simple mode: keep, skip, turn") { onStudioOff() }
                .font(.system(size: 13)).foregroundStyle(ProTheme.muted)
        }
        .padding(14)
    }
}

// MARK: - controls

private struct ToolButton: View {
    let tool: CompactTool
    let active: Bool
    /// Two to a row in the landscape rail.
    var narrow = false
    /// An equal share of the upright tool row.
    var fill = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(spacing: narrow ? 2 : 3) {
                Image(systemName: tool.icon).font(.system(size: narrow ? 15 : 17)).frame(height: narrow ? 19 : 22)
                Text(tool.label).font(.system(size: narrow ? 9 : 10, weight: .medium)).lineLimit(1).minimumScaleFactor(0.8)
            }
            .frame(width: fill ? nil : narrow ? 48 : 62, height: narrow ? 44 : 48)
            .frame(maxWidth: fill ? .infinity : nil)
            .foregroundStyle(active ? ProTheme.accent : ProTheme.muted)
            .background(active ? SS.panel2 : .clear, in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(tool.label)
        .accessibilityAddTraits(active ? .isSelected : [])
    }
}

/// A round, thumb-sized button for the bar (`.ss-icon-btn-big`).
private struct BarButton: View {
    let icon: String
    let label: String
    var active = false
    let action: () -> Void
    @Environment(\.isEnabled) private var enabled
    var body: some View {
        Button(action: action) {
            Image(systemName: icon).font(.system(size: 17, weight: .semibold))
                .frame(width: 44, height: 44)
                .foregroundStyle(active ? ProTheme.ink : ProTheme.ink.opacity(0.9))
                .background(active ? ProTheme.destructive.opacity(0.55) : SS.panel2, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay { RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.black.opacity(0.35), lineWidth: 0.5) }
                .opacity(enabled ? 1 : 0.4)
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel(label)
        .accessibilityAddTraits(active ? .isSelected : [])
    }
}

/// A crop being drawn: the rectangle and aspect, and where it started (to cancel back to).
struct CropDraft {
    var on = false
    var rect = CropMath.full
    var aspect = "Free"
    var ratio: Double?
    var portrait = false
    var start: (rect: [Double]?, angle: Double)?

    mutating func begin(_ s: Slide) {
        guard s.locked == nil else { return }
        start = (s.params.crop, s.params.angle)
        rect = s.params.crop ?? CropMath.full
        aspect = "Free"; ratio = nil
        on = true
    }

    @MainActor mutating func finish(_ model: AppModel) {
        guard on, let s = model.slide else { on = false; return }
        model.setFrame(crop: rect, angle: s.params.angle)
        on = false
    }

    @MainActor mutating func cancel(_ model: AppModel) {
        if let start, on, let s = model.slide, s.params.angle != start.angle || s.params.crop != start.rect {
            model.setFrame(crop: start.rect, angle: start.angle)
        }
        on = false
    }
}
