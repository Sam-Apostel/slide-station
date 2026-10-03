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
    /// Whether a photo is starred now (read from the app's live state), and starring it.
    var starred: ((AlbumPhoto) -> Bool)?
    var onStar: ((AlbumPhoto, Bool) -> Void)?
    /// Save this photo to the device (the Photos library).
    var onSave: ((AlbumPhoto) -> Void)?
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
                title: String? = nil, client: AlbumClient?, starred: ((AlbumPhoto) -> Bool)? = nil,
                onStar: ((AlbumPhoto, Bool) -> Void)? = nil, onSave: ((AlbumPhoto) -> Void)? = nil, onClose: (() -> Void)? = nil) {
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
        self.starred = starred; self.onStar = onStar; self.onSave = onSave
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
            } else {
                Text("No photos in this album yet").foregroundStyle(.white.opacity(0.6))
            }
            GeometryReader { geo in
                let narrow = geo.size.width < 560
                ZStack {
                    shades(photo, narrow: narrow).allowsHitTesting(false)
                    if captions, let photo { caption(photo, raised: chrome && narrow).allowsHitTesting(false) }
                    if chrome { controls(narrow: narrow).transition(.opacity) }
                }
            }
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

    /// What the caption says under the photo, nil when there's nothing.
    private func meta(_ p: AlbumPhoto) -> String? {
        let m = [p.dateText, p.place].compactMap { $0 }.joined(separator: " · ")
        return m.isEmpty ? nil : m
    }

    /// The dark shades behind the controls (top) and the caption (bottom), right to the screen's
    /// edges: drawn as their own layer, so the safe area can't cut them short.
    private func shades(_ p: AlbumPhoto?, narrow: Bool) -> some View {
        let bottom = (captions && p.map { $0.caption != nil || meta($0) != nil } ?? false) || (chrome && narrow)
        return VStack(spacing: 0) {
            LinearGradient(colors: [.black.opacity(0.6), .clear], startPoint: .top, endPoint: .bottom)
                .frame(height: edge * 4).opacity(chrome ? 1 : 0)
            Spacer(minLength: 0)
            LinearGradient(colors: [.clear, .black.opacity(0.6)], startPoint: .top, endPoint: .bottom)
                .frame(height: edge * (chrome && narrow ? 8 : 5)).opacity(bottom ? 1 : 0)
        }
        .ignoresSafeArea()
        .animation(.easeInOut(duration: 0.25), value: chrome)
    }

    /// `raised`: the playback buttons sit under it (a narrow screen with the controls showing).
    private func caption(_ p: AlbumPhoto, raised: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let c = p.caption { Text(c).font(captionFont).lineLimit(2) }
            if let m = meta(p) { Text(m).font(metaFont).opacity(0.8) }
        }
        .foregroundStyle(.white)
        .shadow(color: .black.opacity(0.8), radius: 6)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        .padding(.horizontal, edge > 40 ? edge : 20)
        .padding(.bottom, raised ? 84 : edge > 40 ? edge * 0.8 : 16)
        .animation(.easeInOut(duration: 0.25), value: raised)
        .id("caption-" + p.id)
        .transition(.opacity)
    }

    #if os(tvOS)
    private let edge: CGFloat = 80
    #else
    private let edge: CGFloat = 28
    #endif

    /// Wide: one row along the top. Narrow (a phone upright): close, the title and the timer on
    /// top, previous / play / next centred at the bottom, under the thumb.
    private func controls(narrow: Bool) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                #if !os(tvOS)
                if let onClose {
                    Button(action: onClose) { Image(systemName: "xmark") }
                        .buttonStyle(RoundGlass()).accessibilityLabel("Close")
                }
                #endif
                VStack(alignment: .leading, spacing: 2) {
                    if let title { Text(title).font(.system(size: edge > 40 ? 30 : 15, weight: .semibold)).lineLimit(1).truncationMode(.middle) }
                    if !order.isEmpty { Text("\(index + 1) of \(order.count)").font(.system(size: edge > 40 ? 24 : 12).monospacedDigit()).opacity(0.7) }
                }
                .foregroundStyle(.white).shadow(color: .black.opacity(0.6), radius: 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                #if os(tvOS)
                Label(playing ? "Playing" : "Paused", systemImage: playing ? "play.fill" : "pause.fill")
                    .font(.system(size: 24, weight: .medium)).foregroundStyle(.white.opacity(0.8))
                #else
                photoActions
                if !narrow { settingsMenu; playback }
                #endif
            }
            .padding(.horizontal, edge > 40 ? edge : 16).padding(.top, edge > 40 ? edge * 0.7 : 8)
            Spacer(minLength: 0)
            #if !os(tvOS)
            if narrow {
                HStack(spacing: 14) { settingsMenu; playback }.padding(.bottom, 16)
            }
            #endif
        }
    }

    #if !os(tvOS)
    /// Star and save, for the photo on screen (when the app offers them).
    @ViewBuilder private var photoActions: some View {
        if let photo {
            if let onStar {
                let on = starred?(photo) ?? photo.starred
                Button { onStar(photo, !on); show() } label: { Image(systemName: on ? "star.fill" : "star") }
                    .buttonStyle(RoundGlass(lit: on)).accessibilityLabel(on ? "Unstar" : "Star")
            }
            if let onSave {
                Button { onSave(photo); show() } label: { Image(systemName: "square.and.arrow.down") }
                    .buttonStyle(RoundGlass()).accessibilityLabel("Save to Photos")
            }
        }
    }

    private var settingsMenu: some View {
        Menu {
            Picker("Each photo", selection: $interval) {
                ForEach(SlideshowSettings.intervals, id: \.self) { s in Text(s < 60 ? "\(Int(s)) seconds" : "1 minute").tag(s) }
            }
            Toggle("Captions", isOn: $captions)
        } label: { Image(systemName: "timer") }
            .menuStyle(.button).buttonStyle(RoundGlass()).accessibilityLabel("Slideshow settings")
    }

    private var playback: some View {
        HStack(spacing: 14) {
            Button { step(-1) } label: { Image(systemName: "backward.fill") }.buttonStyle(RoundGlass()).accessibilityLabel("Previous")
            Button { playing.toggle(); show() } label: { Image(systemName: playing ? "pause.fill" : "play.fill") }
                .buttonStyle(RoundGlass(prominent: true)).accessibilityLabel(playing ? "Pause" : "Play")
            Button { step(1) } label: { Image(systemName: "forward.fill") }.buttonStyle(RoundGlass()).accessibilityLabel("Next")
        }
    }
    #endif
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
    /// An amber glyph: on (a starred photo).
    var lit = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(prominent ? ProTheme.accentInk : lit ? ProTheme.accent : .white)
            .frame(width: 42, height: 42)
            .background(prominent ? AnyShapeStyle(ProTheme.accent) : AnyShapeStyle(.ultraThinMaterial), in: Circle())
            .overlay { Circle().strokeBorder(.white.opacity(0.15), lineWidth: 0.5) }
            .opacity(configuration.isPressed ? 0.75 : 1)
            .environment(\.colorScheme, .dark)
    }
}
