import ProUI
import SlideKit
import SwiftUI

/// Simple mode: one slide at a time, full screen. Swipe left (or Keep) to keep it, Skip to leave
/// it out, Turn if it's on its side. After the last slide: the finish line, "Send to Immich".
/// Auto restore, rotation guesses and best-of-bracket have already done the rest.
struct SimpleReviewView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var width
    @AppStorage("studio") private var studio = false
    @State private var drag: CGSize = .zero
    @State private var before = false

    var body: some View {
        if let tray = model.tray {
            VStack(spacing: 0) {
                header(tray)
                if let slide = model.slide {
                    stage(tray, slide)
                    controls
                } else {
                    FinishLine(tray: tray)
                }
            }
            .background(ProTheme.well.ignoresSafeArea())
        }
    }

    private func header(_ tray: Tray) -> some View {
        VStack(spacing: 10) {
            HStack(spacing: 14) {
                Button { model.close() } label: { Image(systemName: "chevron.left").font(.system(size: 18, weight: .semibold)).frame(width: 44, height: 44) }
                    .accessibilityLabel("All trays")
                VStack(alignment: .leading, spacing: 1) {
                    Text(tray.name).font(.system(size: 17, weight: .semibold)).lineLimit(1)
                    Text(model.selection < tray.groups.count ? "Slide \(model.selection + 1) of \(tray.groups.count)" : "All \(tray.groups.count) looked at")
                        .font(.system(size: 13).monospacedDigit()).foregroundStyle(ProTheme.muted)
                }
                Spacer()
                if width == .regular {
                    Button("Studio") { studio = true }.font(.system(size: 15, weight: .medium)).foregroundStyle(ProTheme.muted)
                }
            }
            TrayGauge(statuses: model.statuses, current: model.selection < tray.groups.count ? model.selection : nil)
        }
        .padding(.horizontal, 16).padding(.bottom, 10)
        .foregroundStyle(ProTheme.ink)
    }

    private func stage(_ tray: Tray, _ slide: Slide) -> some View {
        GeometryReader { geo in
            ZStack {
                SlideImage(tray: tray, slide: slide, edge: 1600, before: before)
                    .padding(12)
                    .offset(x: drag.width, y: 0)
                    .rotationEffect(.degrees(Double(drag.width) / 40))
                    .opacity(1 - min(0.5, abs(Double(drag.width)) / 600))
                // preload the next slide so the swipe lands on a finished picture
                if model.selection + 1 < tray.groups.count {
                    SlideImage(tray: tray, slide: tray.groups[model.selection + 1], edge: 1600).frame(width: 1, height: 1).opacity(0).accessibilityHidden(true)
                }
                if drag.width < -60 { stamp("Keep", ProTheme.accent) } else if drag.width > 60 { stamp("Back", ProTheme.muted) }
                VStack {
                    Spacer()
                    if let reason = hint(slide) {
                        Text(reason).font(.system(size: 13, weight: .medium)).foregroundStyle(ProTheme.muted)
                            .padding(.horizontal, 12).padding(.vertical, 6).background(.black.opacity(0.5), in: Capsule())
                    }
                }.padding(.bottom, 16)
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 20)
                    .onChanged { drag = $0.translation }
                    .onEnded { v in
                        let x = v.predictedEndTranslation.width
                        if x < -geo.size.width * 0.35 { withAnimation(.snappy) { drag = .zero; model.keep() } }
                        else if x > geo.size.width * 0.35 { withAnimation(.snappy) { drag = .zero; model.back() } }
                        else { withAnimation(.snappy) { drag = .zero } }
                    }
            )
            // press and hold to see the scan as it came off the scanner
            .onLongPressGesture(minimumDuration: 0.25, maximumDistance: 10) {} onPressingChanged: { before = $0 }
            .accessibilityAction(named: "Keep") { model.keep() }
            .accessibilityAction(named: "Skip") { model.skip() }
        }
    }

    private func stamp(_ text: String, _ color: Color) -> some View {
        Text(text.uppercased()).font(.system(size: 28, weight: .heavy)).tracking(2).foregroundStyle(color)
            .padding(.horizontal, 18).padding(.vertical, 8)
            .overlay { RoundedRectangle(cornerRadius: 10).strokeBorder(color, lineWidth: 3) }
            .rotationEffect(.degrees(-8))
    }

    private func hint(_ slide: Slide) -> String? {
        if before { return "Before" }
        if slide.skip { return "Skipped" }
        if slide.reviewed { return "Kept" }
        switch slide.rotReason {
        case "faces": return "Turned upright — faces"
        case "sky": return "Turned upright — sky"
        default: return nil
        }
    }

    private var controls: some View {
        HStack(spacing: 10) {
            Button { model.back() } label: { Image(systemName: "arrow.uturn.backward") }
                .buttonStyle(BigButtonStyle()).frame(maxWidth: 72).disabled(model.selection == 0)
                .accessibilityLabel("Back")
            Button { model.skip() } label: { Label("Skip", systemImage: "xmark") }.buttonStyle(BigButtonStyle())
            Button { withAnimation(.snappy) { model.turn() } } label: { Label("Turn", systemImage: "rotate.right") }.buttonStyle(BigButtonStyle())
            Button { withAnimation(.snappy) { model.keep() } } label: { Label("Keep", systemImage: "checkmark") }.buttonStyle(BigButtonStyle(prominent: true))
        }
        .labelStyle(.titleAndIcon)
        .padding(.horizontal, 16).padding(.vertical, 12)
        .frame(maxWidth: 640)
        // hardware keyboard: the same keys as the desktop app
        .background {
            Group {
                Button("") { model.keep() }.keyboardShortcut(.space, modifiers: [])
                Button("") { model.keep() }.keyboardShortcut(.rightArrow, modifiers: [])
                Button("") { model.back() }.keyboardShortcut(.leftArrow, modifiers: [])
                Button("") { model.skip() }.keyboardShortcut("x", modifiers: [])
                Button("") { model.turn() }.keyboardShortcut("r", modifiers: [])
            }.opacity(0).accessibilityHidden(true)
        }
    }
}

/// After the last slide: what happens next, in one button.
struct FinishLine: View {
    @Environment(AppModel.self) private var model
    let tray: Tray

    var body: some View {
        let s = tray.summary()
        let undecided = tray.groups.filter { !$0.reviewed && !$0.skip }.count
        let allUp = s.slides > 0 && s.uploaded == s.slides - s.skipped
        VStack(spacing: 22) {
            Spacer()
            Image(systemName: allUp ? "checkmark.circle.fill" : "flag.checkered")
                .font(.system(size: 56)).foregroundStyle(allUp ? ProTheme.green : ProTheme.accent)
            Text(allUp ? "All in Immich" : "That's the tray").font(.system(size: 26, weight: .bold))
            HStack(spacing: 28) {
                stat("\(tray.groups.filter { $0.reviewed && !$0.skip }.count)", "kept")
                stat("\(s.skipped)", "skipped")
                stat("\(s.uploaded)", "in Immich")
            }
            if allUp {
                Text("They're in the album “\(tray.album)”.").foregroundStyle(ProTheme.muted)
                Button("Done") { model.close() }.buttonStyle(BigButtonStyle(prominent: true)).frame(maxWidth: 360)
            } else {
                if undecided > 0 {
                    Text(undecided == 1 ? "1 slide isn't decided yet; only kept slides go to Immich." : "\(undecided) slides aren't decided yet; only kept slides go to Immich.")
                        .foregroundStyle(ProTheme.muted).multilineTextAlignment(.center)
                }
                if s.readyUpload > 0 {
                    Button { model.upload(onlyReady: true) } label: { Label("Send \(s.readyUpload) to Immich", systemImage: "icloud.and.arrow.up") }
                        .buttonStyle(BigButtonStyle(prominent: true)).frame(maxWidth: 360).disabled(model.busy)
                } else if s.uploaded > 0 {
                    Label("Everything you kept is in “\(tray.album)”", systemImage: "checkmark.circle").foregroundStyle(ProTheme.green)
                }
                if undecided > 0, let first = tray.groups.firstIndex(where: { !$0.reviewed && !$0.skip }) {
                    Button("Go to the first undecided slide") { model.select(first) }.buttonStyle(BigButtonStyle()).frame(maxWidth: 360)
                }
            }
            Button("Look through again") { model.select(0) }.foregroundStyle(ProTheme.muted).padding(.top, 4)
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity)
    }

    private func stat(_ n: String, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text(n).font(.system(size: 28, weight: .semibold).monospacedDigit())
            Text(label).font(.system(size: 13)).foregroundStyle(ProTheme.muted)
        }
    }
}
