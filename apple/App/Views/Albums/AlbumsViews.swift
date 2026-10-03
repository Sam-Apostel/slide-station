import ProUI
import SlideAlbums
import SwiftUI

/// A slideshow to put on screen: an album, all followed albums, or the photo the widget showed.
struct AlbumSlideshow: Identifiable {
    let id = UUID()
    var photos: [AlbumPhoto]
    var start = 0
    var title: String?
    var shuffle = SlideshowSettings.shuffle
    /// Play at once; off when it opens on one photo to look at (the widget, a tapped thumbnail).
    var autoplay = true

    /// `slidestation://photo/<album>/<photo>` (the widget): that album, starting at that photo.
    @MainActor init?(url: URL, library: AlbumLibrary) {
        let parts = url.pathComponents.filter { $0 != "/" }
        guard url.scheme == "slidestation", url.host() == "photo", parts.count == 2 else { return nil }
        let photos = library.photos[parts[0]] ?? AlbumCache.photos(parts[0])?.photos ?? []
        guard let i = photos.firstIndex(where: { $0.id == parts[1] }) else { return nil }
        self.init(photos: photos, start: i, title: library.album(parts[0])?.name, shuffle: false, autoplay: false)
    }

    init(photos: [AlbumPhoto], start: Int = 0, title: String?, shuffle: Bool = SlideshowSettings.shuffle, autoplay: Bool = true) {
        self.photos = photos; self.start = start; self.title = title; self.shuffle = shuffle; self.autoplay = autoplay
    }
}

/// The slideshow as the app shows it: with star and Save to Photos, the save's progress, and the
/// screen kept on.
struct AppSlideshow: View {
    @Environment(AppModel.self) private var model
    @Environment(AlbumLibrary.self) private var albums
    let show: AlbumSlideshow
    let close: () -> Void

    var body: some View {
        SlideshowView(photos: show.photos, start: show.start, shuffle: show.shuffle, autoplay: show.autoplay, title: show.title,
                      client: albums.client,
                      starred: { albums.current($0).starred },
                      onStar: { p, on in Task { await albums.star([p], on) } },
                      onSave: { model.saveToPhotos([$0]) },
                      onClose: close)
            .overlay(alignment: .top) { JobBanner().padding(.top, 52) }
            .animation(.snappy, value: model.job == nil)
            .idleTimerDisabled()
    }
}

/// Home's albums: the ones followed as covers, Play all, and the way to choose others.
struct AlbumsSection: View {
    @Environment(AlbumLibrary.self) private var albums
    @State private var choosing = false
    @State private var playing: AlbumSlideshow?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("ALBUMS").font(.system(size: 11, weight: .semibold)).tracking(0.8).foregroundStyle(ProTheme.dim)
                if albums.loading { ProgressView().controlSize(.mini).tint(ProTheme.dim) }
                Spacer()
                Button("Choose…") { choosing = true }.font(.system(size: 14, weight: .medium)).foregroundStyle(ProTheme.accent)
            }
            if albums.followedAlbums.isEmpty {
                Button { choosing = true } label: {
                    Label(albums.albums.isEmpty ? (albums.loading ? "Looking for albums…" : "No albums yet") : "Choose the albums to show here, in the slideshow and in the widget",
                          systemImage: "rectangle.stack.badge.plus")
                        .font(.system(size: 15)).foregroundStyle(ProTheme.muted)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(16)
                        .background(ProTheme.canvas, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                .buttonStyle(.plain)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach(albums.followedAlbums) { a in
                            NavigationLink(value: a) { AlbumCard(album: a) }.buttonStyle(.plain)
                        }
                    }
                }
                let all = albums.followedPhotos
                if all.count > 1 {
                    Button { playing = AlbumSlideshow(photos: all, title: albums.followedAlbums.count == 1 ? albums.followedAlbums[0].name : "All albums") } label: {
                        Label("Play \(all.count) slides", systemImage: "play.fill")
                    }
                    .buttonStyle(BigButtonStyle(prominent: true)).frame(maxWidth: 360)
                }
            }
            if let p = albums.problem {
                Label(p, systemImage: "exclamationmark.triangle").font(.system(size: 13)).foregroundStyle(ProTheme.warn)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .sheet(isPresented: $choosing) { ChooseAlbumsView() }
        .fullScreenCover(item: $playing) { show in AppSlideshow(show: show) { playing = nil } }
    }
}

/// An album's cover, name and count.
struct AlbumCard: View {
    @Environment(AlbumLibrary.self) private var albums
    let album: ImmichAlbum
    var width: CGFloat = 200

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Group {
                if let cover = album.coverID ?? albums.photos[album.id]?.first?.id {
                    RemotePhoto(cover, size: .preview, maxPixel: Int(width * 3), client: albums.client)
                } else {
                    Rectangle().fill(ProTheme.canvas).overlay { Image(systemName: "photo.stack").foregroundStyle(ProTheme.dim) }
                }
            }
            .frame(width: width, height: width * 2 / 3)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.white.opacity(0.06), lineWidth: 1) }
            Text(album.name).font(.system(size: 15, weight: .semibold)).lineLimit(1).foregroundStyle(ProTheme.ink)
            Text(subtitle).font(.system(size: 12)).foregroundStyle(ProTheme.muted).lineLimit(1)
        }
        .frame(width: width, alignment: .leading)
        .contentShape(Rectangle())
    }

    private var subtitle: String {
        var parts = ["\(album.count) slides"]
        if let years = albums.photos[album.id].flatMap(ImmichDate.span) { parts.append(years) }
        if let by = album.sharedBy { parts.append("from \(by)") }
        return parts.joined(separator: " · ")
    }
}

/// One album: every photo in a grid, oldest first (tray order). Tap one to look from there; Play.
/// Select works as in Photos: Select, tap photos (or swipe across them) to pick, then save them to
/// the device or star them.
struct AlbumScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(AlbumLibrary.self) private var albums
    let album: ImmichAlbum
    @State private var playing: AlbumSlideshow?
    @State private var selecting = false
    @State private var selected: Set<String> = []
    @State private var width: CGFloat = 0
    /// A swipe across the grid that picks photos: where it started, and what was picked before it.
    @State private var sweep: (start: Int, adding: Bool, before: Set<String>)?

    private let gap: CGFloat = 2
    private var columns: Int { max(3, Int((width + gap) / ((Platform.isMac ? 150 : 110) + gap))) }
    private var cell: CGFloat { max(1, (width - CGFloat(columns - 1) * gap) / CGFloat(columns)) }

    var body: some View {
        let photos = albums.photos[album.id] ?? []
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header(photos)
                grid(photos)
                if photos.isEmpty {
                    Text(albums.loading ? "Loading…" : "Nothing in this album yet.").foregroundStyle(ProTheme.muted).padding(.horizontal, 20).padding(.top, 20)
                }
            }
            .padding(.vertical, 20)
            .frame(maxWidth: 1200)
            .frame(maxWidth: .infinity)
        }
        .scrollDisabled(sweep != nil)
        .background(ProTheme.background)
        .foregroundStyle(ProTheme.ink)
        .refreshable { await albums.loadPhotos(album.id) }
        .task { await albums.loadPhotos(album.id) }
        .navigationTitle(album.name)
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(selecting)
        .toolbar { toolbar(photos) }
        .safeAreaInset(edge: .bottom) { if selecting { selectionBar(photos) } }
        .animation(.snappy(duration: 0.2), value: selecting)
        .fullScreenCover(item: $playing) { show in AppSlideshow(show: show) { playing = nil } }
    }

    private var selectionTitle: String {
        selected.isEmpty ? "Select Items" : selected.count == 1 ? "1 Photo Selected" : "\(selected.count) Photos Selected"
    }

    private func header(_ photos: [AlbumPhoto]) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .bottom, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(album.name).font(.system(size: 28, weight: .bold)).lineLimit(2)
                    Text([["\(photos.isEmpty ? album.count : photos.count) slides"], [ImmichDate.span(photos)], [album.sharedBy.map { "shared by \($0)" }]]
                            .flatMap { $0 }.compactMap { $0 }.joined(separator: " · "))
                        .foregroundStyle(ProTheme.muted)
                }
                Spacer(minLength: 0)
                // says what it is: followed or not (a tinted toggle reads the same either way)
                let following = albums.isFollowed(album.id)
                Button { albums.setFollowing(album.id, !following) } label: {
                    Label(following ? "Following" : "Follow", systemImage: following ? "checkmark" : "plus")
                        .font(.system(size: 14, weight: .semibold))
                        .padding(.horizontal, 14).frame(height: 34)
                        .foregroundStyle(following ? ProTheme.ink : ProTheme.accentInk)
                        .background(following ? AnyShapeStyle(Color.white.opacity(0.1)) : AnyShapeStyle(ProTheme.accent), in: Capsule())
                }
                .buttonStyle(.plain).fixedSize()
                .help("Followed albums play in the slideshow, the widget and on Apple TV")
            }
            if photos.count > 0 && !selecting {
                HStack(spacing: 10) {
                    Button { playing = AlbumSlideshow(photos: photos, title: album.name, shuffle: false) } label: { Label("Play", systemImage: "play.fill") }
                        .buttonStyle(BigButtonStyle(prominent: true))
                    Button { playing = AlbumSlideshow(photos: photos, start: Int.random(in: 0..<photos.count), title: album.name, shuffle: true) } label: { Label("Shuffle", systemImage: "shuffle") }
                        .buttonStyle(BigButtonStyle())
                }
                .frame(maxWidth: 420)
            }
        }
        .padding(.horizontal, 20)
    }

    // MARK: the grid

    private func grid(_ photos: [AlbumPhoto]) -> some View {
        LazyVGrid(columns: Array(repeating: GridItem(.fixed(cell), spacing: gap), count: columns), spacing: gap) {
            ForEach(Array(photos.enumerated()), id: \.element.id) { i, p in
                thumb(p, at: i, in: photos)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .coordinateSpace(name: "grid")
        // swiping sideways across photos picks every one between, as in Photos; up and down scrolls
        .simultaneousGesture(selecting ? sweepGesture(photos) : nil)
    }

    private func thumb(_ p: AlbumPhoto, at i: Int, in photos: [AlbumPhoto]) -> some View {
        let on = selected.contains(p.id)
        return Button {
            if selecting { toggle(p.id) } else { playing = AlbumSlideshow(photos: photos, start: i, title: album.name, shuffle: false, autoplay: false) }
        } label: {
            RemotePhoto(p.id, size: .thumbnail, maxPixel: 360, client: albums.client)
                .frame(width: cell, height: cell)
                .clipped()
                .overlay { if on { Color.black.opacity(0.18) } }
                .overlay(alignment: .bottomLeading) {
                    if p.starred {
                        Image(systemName: "star.fill").font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                            .shadow(color: .black.opacity(0.6), radius: 2).padding(6)
                    }
                }
                .overlay(alignment: .bottomTrailing) {
                    if selecting && on {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 22))
                            .symbolRenderingMode(.palette).foregroundStyle(.white, Color(red: 0.04, green: 0.52, blue: 1))   // Photos' blue
                            .background(Circle().fill(.white).padding(2))
                            .shadow(color: .black.opacity(0.35), radius: 2)
                            .padding(5)
                            .transition(.scale.combined(with: .opacity))
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .animation(.snappy(duration: 0.15), value: on)
        .accessibilityLabel(p.caption ?? p.dateText ?? "Slide \(i + 1)")
        .accessibilityAddTraits(selecting && on ? .isSelected : [])
        .contextMenu {
            if !selecting {
                Button("Save to Photos", systemImage: "square.and.arrow.down") { model.saveToPhotos([p]) }
                Button(p.starred ? "Unstar" : "Star", systemImage: p.starred ? "star.slash" : "star") { Task { await albums.star([p], !p.starred) } }
                Button("Play from Here", systemImage: "play") { playing = AlbumSlideshow(photos: photos, start: i, title: album.name, shuffle: false) }
                Button("Select", systemImage: "checkmark.circle") { selecting = true; selected = [p.id] }
            }
        }
    }

    private func toggle(_ id: String) {
        if selected.contains(id) { selected.remove(id) } else { selected.insert(id) }
    }

    /// The photo under a point of the grid (nil between rows or past the end).
    private func index(at pt: CGPoint, count: Int) -> Int? {
        guard cell > 0, pt.x >= 0, pt.y >= 0 else { return nil }
        let col = min(columns - 1, Int(pt.x / (cell + gap))), row = Int(pt.y / (cell + gap))
        let i = row * columns + col
        return i < count ? i : nil
    }

    private func sweepGesture(_ photos: [AlbumPhoto]) -> some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .named("grid"))
            .onChanged { v in
                if sweep == nil {
                    // only a sideways start picks; a vertical one is the scroll view's
                    guard abs(v.translation.width) > abs(v.translation.height),
                          let start = index(at: v.startLocation, count: photos.count) else { return }
                    sweep = (start, !selected.contains(photos[start].id), selected)
                }
                guard let s = sweep, let now = index(at: v.location, count: photos.count) else { return }
                let run = Set(photos[min(s.start, now)...max(s.start, now)].map(\.id))
                selected = s.adding ? s.before.union(run) : s.before.subtracting(run)
            }
            .onEnded { _ in sweep = nil }
    }

    // MARK: bars

    @ToolbarContentBuilder private func toolbar(_ photos: [AlbumPhoto]) -> some ToolbarContent {
        if selecting {
            ToolbarItem(placement: .cancellationAction) {
                Button(selected.count == photos.count ? "Deselect All" : "Select All") {
                    selected = selected.count == photos.count ? [] : Set(photos.map(\.id))
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Cancel") { selecting = false; selected = [] }
            }
        } else if !photos.isEmpty {
            ToolbarItem(placement: .primaryAction) {
                Button("Select") { selecting = true }
            }
        }
    }

    /// Save and Star for the selected photos, along the bottom like Photos' toolbar.
    private func selectionBar(_ photos: [AlbumPhoto]) -> some View {
        let picked = photos.filter { selected.contains($0.id) }
        let allStarred = !picked.isEmpty && picked.allSatisfy(\.starred)
        return HStack {
            Button { Task { await albums.star(picked, !allStarred) } } label: {
                Label(allStarred ? "Unstar" : "Star", systemImage: allStarred ? "star.slash" : "star")
            }
            Spacer()
            Text(selectionTitle).font(.system(size: 13, weight: .medium)).foregroundStyle(ProTheme.muted)
            Spacer()
            Button {
                model.saveToPhotos(picked)
                selecting = false; selected = []
            } label: { Label("Save", systemImage: "square.and.arrow.down") }
        }
        .labelStyle(.iconOnly)
        .font(.system(size: 20))
        .disabled(picked.isEmpty || model.busy)
        .foregroundStyle(picked.isEmpty ? ProTheme.dim : ProTheme.accent)
        .padding(.horizontal, 24).padding(.vertical, 12)
        .background(.bar)
        .overlay(alignment: .top) { Rectangle().fill(ProTheme.line).frame(height: 0.5) }
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

/// Every album the key can see, own and shared: switch on the ones to follow.
struct ChooseAlbumsView: View {
    @Environment(AlbumLibrary.self) private var albums
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                let shared = albums.albums.filter { $0.sharedBy != nil }, own = albums.albums.filter { $0.sharedBy == nil }
                if !shared.isEmpty { section("Shared with you", shared) }
                if !own.isEmpty { section("Your albums", own) }
                if albums.albums.isEmpty {
                    Text(albums.loading ? "Looking for albums…" : albums.problem ?? "This account can't see any albums yet. Ask whoever has the slides to share their album with your Immich account.")
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Albums")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .refreshable { await albums.refresh() }
            .task { if albums.albums.isEmpty { await albums.refresh() } }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 520)
        #endif
    }

    private func section(_ title: String, _ list: [ImmichAlbum]) -> some View {
        Section {
            ForEach(list) { a in
                Toggle(isOn: Binding(get: { albums.isFollowed(a.id) }, set: { albums.setFollowing(a.id, $0) })) {
                    HStack(spacing: 12) {
                        Group {
                            if let c = a.coverID { RemotePhoto(c, size: .thumbnail, maxPixel: 160, client: albums.client) } else { Rectangle().fill(ProTheme.canvas) }
                        }
                        .frame(width: 54, height: 40).clipShape(RoundedRectangle(cornerRadius: 5))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(a.name).lineLimit(1)
                            Text("\(a.count) photos" + (a.sharedBy.map { " · from \($0)" } ?? "")).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        } header: { Text(title) } footer: {
            if title == "Shared with you" { Text("Albums others share with you are followed by themselves.") }
        }
    }
}

/// The Immich server and API key. For someone an album was shared with, it says exactly what to
/// make in Immich.
struct ImmichForm: View {
    @Environment(AlbumLibrary.self) private var albums
    @Binding var url: String
    @Binding var key: String
    @State private var result: String?
    @State private var testing = false
    var onConnected: (() -> Void)?

    var body: some View {
        Section {
            TextField("Server", text: $url, prompt: Text("https://photos.example.com"))
                .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
            SecureField("API key", text: $key)
            Button {
                testing = true
                Task {
                    let problem = await albums.connect(ImmichConnection(url: url, key: key))
                    if let problem { result = problem } else if let s = albums.server {
                        result = "Connected as \(s.user)."
                        onConnected?()
                    }
                    testing = false
                }
            } label: { HStack { Text(albums.isConnected ? "Connect and test" : "Connect"); if testing { Spacer(); ProgressView() } } }
            .disabled(url.trimmingCharacters(in: .whitespaces).isEmpty || key.trimmingCharacters(in: .whitespaces).isEmpty || testing)
            if let result { Text(result).font(.footnote).foregroundStyle(result.hasPrefix("Connected") ? ProTheme.green : ProTheme.destructive) }
        } header: { Text("Immich") } footer: {
            Text("In Immich: your account (top right) → Account Settings → API Keys → New API Key. To look at albums and save them it needs album.read, asset.read, asset.view and asset.download; to star them asset.update, activity.read, activity.create and activity.delete; to upload slides also asset.upload, asset.delete, album.create and albumAsset.create. The server and key are kept in your keychain and reach your other Apple devices through iCloud Keychain, Apple TV included.")
        }
    }
}

/// Home's first card for someone who hasn't connected: the albums are what most people are here for.
struct ConnectCard: View {
    @State private var connecting = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Look at slides in Immich", systemImage: "photo.stack").font(.system(size: 15, weight: .semibold))
            Text("Someone shared an album of slides with you? Connect your Immich account and they play here, in a widget on your Home Screen and on your Apple TV.")
                .foregroundStyle(ProTheme.muted).fixedSize(horizontal: false, vertical: true)
            Button { connecting = true } label: { Label("Connect to Immich", systemImage: "link") }
                .buttonStyle(BigButtonStyle(prominent: true))
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ProTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(ProTheme.line, lineWidth: 1) }
        .sheet(isPresented: $connecting) { ConnectSheet() }
    }
}

struct ConnectSheet: View {
    @Environment(AlbumLibrary.self) private var albums
    @Environment(\.dismiss) private var dismiss
    @State private var url = ""
    @State private var key = ""

    var body: some View {
        NavigationStack {
            Form { ImmichForm(url: $url, key: $key) { dismiss() } }
                .formStyle(.grouped)
                .navigationTitle("Connect to Immich")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
                .onAppear { url = albums.connection.url; key = albums.connection.key }
        }
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 360)
        #endif
    }
}
