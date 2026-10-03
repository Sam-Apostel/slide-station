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

    /// `slidestation://photo/<album>/<photo>` (the widget): that album, starting at that photo.
    @MainActor init?(url: URL, library: AlbumLibrary) {
        let parts = url.pathComponents.filter { $0 != "/" }
        guard url.scheme == "slidestation", url.host() == "photo", parts.count == 2 else { return nil }
        let photos = library.photos[parts[0]] ?? AlbumCache.photos(parts[0])?.photos ?? []
        guard let i = photos.firstIndex(where: { $0.id == parts[1] }) else { return nil }
        self.init(photos: photos, start: i, title: library.album(parts[0])?.name, shuffle: false)
    }

    init(photos: [AlbumPhoto], start: Int = 0, title: String?, shuffle: Bool = SlideshowSettings.shuffle) {
        self.photos = photos; self.start = start; self.title = title; self.shuffle = shuffle
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
        .fullScreenCover(item: $playing) { show in
            SlideshowView(photos: show.photos, start: show.start, shuffle: show.shuffle, title: show.title, client: albums.client) { playing = nil }
                .idleTimerDisabled()
        }
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
struct AlbumScreen: View {
    @Environment(AlbumLibrary.self) private var albums
    let album: ImmichAlbum
    @State private var playing: AlbumSlideshow?

    var body: some View {
        let photos = albums.photos[album.id] ?? []
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(album.name).font(.system(size: 28, weight: .bold))
                        Text([["\(photos.isEmpty ? album.count : photos.count) slides"], [ImmichDate.span(photos)], [album.sharedBy.map { "shared by \($0)" }]]
                                .flatMap { $0 }.compactMap { $0 }.joined(separator: " · "))
                            .foregroundStyle(ProTheme.muted)
                    }
                    Spacer()
                    Toggle("Follow", isOn: Binding(get: { albums.isFollowed(album.id) }, set: { albums.setFollowing(album.id, $0) }))
                        .toggleStyle(.button).tint(ProTheme.accent)
                        .help("Followed albums play in the slideshow, the widget and on Apple TV")
                }
                if photos.count > 0 {
                    HStack(spacing: 10) {
                        Button { playing = AlbumSlideshow(photos: photos, title: album.name, shuffle: false) } label: { Label("Play", systemImage: "play.fill") }
                            .buttonStyle(BigButtonStyle(prominent: true))
                        Button { playing = AlbumSlideshow(photos: photos, start: Int.random(in: 0..<photos.count), title: album.name, shuffle: true) } label: { Label("Shuffle", systemImage: "shuffle") }
                            .buttonStyle(BigButtonStyle())
                    }
                    .frame(maxWidth: 420)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: Platform.isMac ? 150 : 104), spacing: 4)], spacing: 4) {
                    ForEach(Array(photos.enumerated()), id: \.element.id) { i, p in
                        Button { playing = AlbumSlideshow(photos: photos, start: i, title: album.name, shuffle: false) } label: {
                            Color.clear.aspectRatio(1, contentMode: .fit)
                                .overlay { RemotePhoto(p.id, size: .thumbnail, maxPixel: 360, client: albums.client) }
                                .clipShape(RoundedRectangle(cornerRadius: 3))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(p.caption ?? p.dateText ?? "Slide \(i + 1)")
                    }
                }
                if photos.isEmpty {
                    Text(albums.loading ? "Loading…" : "Nothing in this album yet.").foregroundStyle(ProTheme.muted).padding(.top, 20)
                }
            }
            .padding(20)
            .frame(maxWidth: 1200)
            .frame(maxWidth: .infinity)
        }
        .background(ProTheme.background)
        .foregroundStyle(ProTheme.ink)
        .refreshable { await albums.loadPhotos(album.id) }
        .task { await albums.loadPhotos(album.id) }
        .navigationTitle(album.name)
        .navigationBarTitleDisplayMode(.inline)
        .fullScreenCover(item: $playing) { show in
            SlideshowView(photos: show.photos, start: show.start, shuffle: show.shuffle, autoplay: show.start == 0 || show.shuffle,
                          title: show.title, client: albums.client) { playing = nil }
                .idleTimerDisabled()
        }
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
            Text("In Immich: your account (top right) → Account Settings → API Keys → New API Key. To look at albums it needs album.read, asset.read, asset.view and asset.download; to upload slides also asset.upload, asset.delete, album.create and albumAsset.create. The server and key are kept in your keychain and reach your other Apple devices through iCloud Keychain, Apple TV included.")
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
