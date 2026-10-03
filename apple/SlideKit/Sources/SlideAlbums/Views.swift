import ProUI
import SwiftUI

/// A photo from Immich, fetched and decoded off the main thread. Shows the cached image at once
/// when there is one.
public struct RemotePhoto: View {
    let id: String
    let size: AlbumClient.Size
    let maxPixel: Int
    let client: AlbumClient?
    var contentMode: ContentMode
    @State private var image: CGImage?
    @State private var failed = false

    public init(_ id: String, size: AlbumClient.Size = .thumbnail, maxPixel: Int = 400, client: AlbumClient?, contentMode: ContentMode = .fill) {
        self.id = id; self.size = size; self.maxPixel = maxPixel; self.client = client; self.contentMode = contentMode
    }

    public var body: some View {
        ZStack {
            if let image {
                Image(decorative: image, scale: 1).resizable().aspectRatio(contentMode: contentMode)
            } else {
                Rectangle().fill(ProTheme.canvas)
                    .overlay { if failed { Image(systemName: "photo").foregroundStyle(ProTheme.dim) } }
            }
        }
        .task(id: "\(id)|\(size.rawValue)|\(maxPixel)") {
            failed = false
            if let hit = await PhotoImages.shared.cached(id, size: size, maxPixel: maxPixel) { image = hit; return }
            guard let client else { failed = true; return }
            do { image = try await PhotoImages.shared.image(id, size: size, maxPixel: maxPixel, client: client) } catch { if !Task.isCancelled { failed = true } }
        }
    }
}

/// Photos one after the other, full screen, the way a projector shows a tray: a slow cross-fade and
/// a slight drift, the caption, date and place underneath.
///
/// - Touch: tap for the controls, swipe for the next or previous photo.
/// - Keyboard (Mac, iPad): ← → move, Space plays and pauses, Esc closes.
/// - Siri Remote: left / right move, play/pause, Menu (Back) closes.
public struct SlideshowView: View {
    let client: AlbumClient?
    let title: String?
    let onClose: (() -> Void)?
    @State private var order: [AlbumPhoto]
    @State private var index: Int
    @State private var playing: Bool
    @State private var chrome = true
    @State private var images: [String: CGImage] = [:]
    @State private var interval = SlideshowSettings.interval
    @State private var captions = SlideshowSettings.captions
    @State private var drag: CGFloat = 0
    /// How far it's being pulled down to close.
    @State private var lift: CGFloat = 0
    @State private var tick = 0   // restarts the timer after a manual move
    @FocusState private var focused: Bool

    /// `start`: the photo to begin with (an index into `photos`). With `shuffle`, the rest follow in
    /// a random order.
    public init(photos: [AlbumPhoto], start: Int = 0, shuffle: Bool = SlideshowSettings.shuffle, autoplay: Bool = true,
                title: String? = nil, client: AlbumClient?, onClose: (() -> Void)? = nil) {
        var o = photos
        var i = photos.indices.contains(start) ? start : 0
        if shuffle, !photos.isEmpty {
            let first = photos[i]
            o = [first] + photos.enumerated().filter { $0.offset != i }.map(\.element).shuffled()
            i = 0
        }
        _order = State(initialValue: o)
        _index = State(initialValue: i)
        _playing = State(initialValue: autoplay)
        self.title = title; self.client = client; self.onClose = onClose
    }

    #if os(tvOS)
    static let pixels = 3840, size = AlbumClient.Size.fullsize
    #elseif os(macOS)
    static let pixels = 3200, size = AlbumClient.Size.fullsize
    #else
    static let pixels = 2400, size = AlbumClient.Size.preview
    #endif

    private var photo: AlbumPhoto? { order.indices.contains(index) ? order[index] : nil }

    public var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let photo {
                if let img = images[photo.id] {
                    PhotoLayer(image: img, seed: photo.id.hashValue, drift: playing ? interval + 2 : 0)
                        .id(photo.id)
                        .transition(.opacity)
                        .offset(x: drag, y: lift)
                        .scaleEffect(1 - min(0.15, lift / 2000))
                } else {
                    ProgressView().tint(.white)
                }
                if captions { caption(photo).allowsHitTesting(false) }
            } else {
                Text("No photos in this album yet").foregroundStyle(.white.opacity(0.6))
            }
            if chrome { controls.transition(.opacity) }
        }
        .animation(.easeInOut(duration: 1.1), value: photo?.id)
        .animation(.easeInOut(duration: 0.25), value: chrome)
        .contentShape(Rectangle())
        #if os(tvOS)
        .focusable()
        .focused($focused)
        .onMoveCommand { d in
            if d == .left { step(-1) } else if d == .right { step(1) } else { show() }
        }
        .onPlayPauseCommand { playing.toggle(); show() }
        .onExitCommand { onClose?() }
        .onTapGesture {   // the remote's select: first the controls, then play / pause
            if chrome { playing.toggle() }
            show()
        }
        #else
        .onTapGesture { withAnimation { chrome.toggle() } }
        // sideways: the next or previous photo; down: close, as in Photos
        .gesture(DragGesture(minimumDistance: 24)
            .onChanged { v in
                if abs(v.translation.width) > abs(v.translation.height) { drag = v.translation.width * 0.4 }
                else if v.translation.height > 0 { lift = v.translation.height }
            }
            .onEnded { v in
                let x = v.predictedEndTranslation.width, y = v.predictedEndTranslation.height
                withAnimation(.snappy) { drag = 0; lift = 0 }
                if abs(x) > abs(y) {
                    if x < -120 { step(1) } else if x > 120 { step(-1) }
                } else if y > 160, let onClose { onClose() }
            })
        .focusable()
        .focusEffectDisabled()
        .focused($focused)
        .onKeyPress(.leftArrow) { step(-1); return .handled }
        .onKeyPress(.rightArrow) { step(1); return .handled }
        .onKeyPress(.space) { playing.toggle(); show(); return .handled }
        .onKeyPress(.escape) { onClose?(); return .handled }
        #endif
        .onAppear { focused = true }
        // the next photo is fetched while this one shows, so the fade lands on a finished picture
        .task(id: "\(photo?.id ?? "")|\(order.count)") { await load(around: index) }
        .task(id: "\(playing)|\(index)|\(tick)") {
            guard playing, order.count > 1 else { return }
            try? await Task.sleep(for: .seconds(interval))
            guard !Task.isCancelled else { return }
            let next = (index + 1) % order.count
            await load(around: next)   // wait for it rather than fade to nothing
            guard !Task.isCancelled, playing else { return }
            index = next
        }
        // the controls go away by themselves while it plays
        .task(id: "\(chrome)|\(playing)|\(tick)") {
            guard chrome, playing else { return }
            try? await Task.sleep(for: .seconds(3.5))
            if !Task.isCancelled { chrome = false }
        }
        .onChange(of: interval) { SlideshowSettings.interval = interval }
        .onChange(of: captions) { SlideshowSettings.captions = captions }
        .preferredColorScheme(.dark)
    }

    private func show() { chrome = true; tick += 1 }

    private func step(_ by: Int) {
        guard !order.isEmpty else { return }
        index = (index + by + order.count) % order.count
        tick += 1
    }

    /// This photo, the next and the one before; drops the rest (full-size images are big).
    private func load(around i: Int) async {
        guard !order.isEmpty, let client else { return }
        let want = [i, (i + 1) % order.count, (i - 1 + order.count) % order.count].map { order[$0].id }
        images = images.filter { want.contains($0.key) }
        for id in want where images[id] == nil {
            if let img = try? await PhotoImages.shared.image(id, size: Self.size, maxPixel: Self.pixels, client: client) {
                images[id] = img
            }
        }
    }

    // MARK: overlays

    #if os(tvOS)
    private let captionFont = Font.system(size: 38, weight: .semibold), metaFont = Font.system(size: 26)
    #else
    private let captionFont = Font.system(size: 20, weight: .semibold), metaFont = Font.system(size: 14)
    #endif

    private func caption(_ p: AlbumPhoto) -> some View {
        let meta = [p.dateText, p.place].compactMap { $0 }.joined(separator: " · ")
        return VStack(alignment: .leading, spacing: 6) {
            if let c = p.caption { Text(c).font(captionFont).lineLimit(2) }
            if !meta.isEmpty { Text(meta).font(metaFont).opacity(0.75) }
        }
        .foregroundStyle(.white)
        .shadow(color: .black.opacity(0.8), radius: 6)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        .padding(.horizontal, edge).padding(.bottom, edge * 0.8)
        .background(alignment: .bottom) {
            LinearGradient(colors: [.clear, .black.opacity(0.55)], startPoint: .top, endPoint: .bottom).frame(height: edge * 5)
                .ignoresSafeArea()   // down to the screen's edge, not the safe area's
        }
        .opacity(p.caption == nil && meta.isEmpty ? 0 : 1)
        .id("caption-" + p.id)
        .transition(.opacity)
    }

    #if os(tvOS)
    private let edge: CGFloat = 80
    #else
    private let edge: CGFloat = 28
    #endif

    private var controls: some View {
        VStack {
            HStack(spacing: 14) {
                #if !os(tvOS)
                if let onClose {
                    Button(action: onClose) { Image(systemName: "xmark") }
                        .buttonStyle(RoundGlass()).accessibilityLabel("Close")
                }
                #endif
                VStack(alignment: .leading, spacing: 2) {
                    if let title { Text(title).font(.system(size: edge > 40 ? 30 : 15, weight: .semibold)).lineLimit(1) }
                    if !order.isEmpty { Text("\(index + 1) of \(order.count)").font(.system(size: edge > 40 ? 24 : 12).monospacedDigit()).opacity(0.7) }
                }
                .foregroundStyle(.white).shadow(color: .black.opacity(0.6), radius: 4)
                Spacer()
                #if os(tvOS)
                Label(playing ? "Playing" : "Paused", systemImage: playing ? "play.fill" : "pause.fill")
                    .font(.system(size: 24, weight: .medium)).foregroundStyle(.white.opacity(0.8))
                #else
                Menu {
                    Picker("Each photo", selection: $interval) {
                        ForEach(SlideshowSettings.intervals, id: \.self) { s in Text(s < 60 ? "\(Int(s)) seconds" : "1 minute").tag(s) }
                    }
                    Toggle("Captions", isOn: $captions)
                } label: { Image(systemName: "timer") }
                    .menuStyle(.button).buttonStyle(RoundGlass()).accessibilityLabel("Slideshow settings")
                Button { step(-1) } label: { Image(systemName: "backward.fill") }.buttonStyle(RoundGlass()).accessibilityLabel("Previous")
                Button { playing.toggle(); show() } label: { Image(systemName: playing ? "pause.fill" : "play.fill") }
                    .buttonStyle(RoundGlass(prominent: true)).accessibilityLabel(playing ? "Pause" : "Play")
                Button { step(1) } label: { Image(systemName: "forward.fill") }.buttonStyle(RoundGlass()).accessibilityLabel("Next")
                #endif
            }
            .padding(.horizontal, edge > 40 ? edge : 16).padding(.top, edge > 40 ? edge * 0.7 : 8)
            .background(alignment: .top) {
                LinearGradient(colors: [.black.opacity(0.55), .clear], startPoint: .top, endPoint: .bottom).frame(height: edge * 4).ignoresSafeArea()
            }
            Spacer()
        }
    }
}

/// One photo: fitted over a blurred, darkened copy of itself (the letterbox in the photo's own
/// colours), drifting slightly while it plays.
struct PhotoLayer: View {
    let image: CGImage
    let seed: Int
    /// Seconds the drift takes; 0: still.
    let drift: Double
    @State private var moved = false

    var body: some View {
        let anchors: [UnitPoint] = [.center, .topLeading, .bottomTrailing, .topTrailing, .bottomLeading]
        let anchor = anchors[abs(seed) % anchors.count]
        // the filled copy sits in an overlay so it can't push the layout past the screen
        Color.clear
            .overlay { Image(decorative: image, scale: 1).resizable().aspectRatio(contentMode: .fill).blur(radius: 50).opacity(0.35) }
            .clipped()
            .overlay {
                Image(decorative: image, scale: 1).resizable().aspectRatio(contentMode: .fit)
                    .scaleEffect(moved ? 1.045 : 1, anchor: anchor)
            }
            .ignoresSafeArea()
        .onAppear {
            guard drift > 0 else { return }
            withAnimation(.linear(duration: drift)) { moved = true }
        }
    }
}

/// Round, glassy buttons over a photo.
struct RoundGlass: ButtonStyle {
    var prominent = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(prominent ? ProTheme.accentInk : .white)
            .frame(width: 42, height: 42)
            .background(prominent ? AnyShapeStyle(ProTheme.accent) : AnyShapeStyle(.ultraThinMaterial), in: Circle())
            .overlay { Circle().strokeBorder(.white.opacity(0.15), lineWidth: 0.5) }
            .opacity(configuration.isPressed ? 0.75 : 1)
            .environment(\.colorScheme, .dark)
    }
}
