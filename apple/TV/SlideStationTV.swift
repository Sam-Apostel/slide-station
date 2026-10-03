import ProUI
import SlideAlbums
import SwiftUI

/// Slide Station on Apple TV: the slides in Immich albums as a slideshow on the big screen.
/// The server and API key usually arrive by themselves through iCloud Keychain from the iPhone,
/// iPad or Mac; otherwise they're typed once (tvOS offers the iPhone's keyboard for that).
@main
struct SlideStationTV: App {
    @State private var albums = AlbumLibrary()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            TVRoot()
                .environment(albums)
                .preferredColorScheme(.dark)
                .task {
                    #if DEBUG
                    // driving it in the simulator: SIMCTL_CHILD_SS_IMMICH_URL / _KEY, SS_PLAY=1
                    let env = ProcessInfo.processInfo.environment
                    if let url = env["SS_IMMICH_URL"], let key = env["SS_IMMICH_KEY"] { await albums.connect(ImmichConnection(url: url, key: key)) }
                    #endif
                    await albums.refresh()
                }
                .onChange(of: phase) { _, now in if now == .active { Task { await albums.refresh() } } }
        }
    }
}

/// What's playing: an album (from a photo in it) or every followed album.
struct TVShow: Identifiable {
    let id = UUID()
    var photos: [AlbumPhoto]
    var start = 0
    var title: String?
    var shuffle: Bool
}

struct TVRoot: View {
    @Environment(AlbumLibrary.self) private var albums
    @State private var show: TVShow?

    var body: some View {
        NavigationStack {
            Group {
                if albums.isConnected { TVHome(show: $show) } else { TVConnect() }
            }
            .navigationDestination(for: ImmichAlbum.self) { TVAlbum(album: $0, show: $show) }
        }
        #if DEBUG
        .task(id: albums.followedPhotos.count) {
            if ProcessInfo.processInfo.environment["SS_PLAY"] != nil, show == nil, !albums.followedPhotos.isEmpty {
                show = TVShow(photos: albums.followedPhotos, title: albums.followedAlbums.first?.name, shuffle: false)
            }
        }
        #endif
        .fullScreenCover(item: $show) { s in
            SlideshowView(photos: s.photos, start: s.start, shuffle: s.shuffle, title: s.title, client: albums.client) { show = nil }
                .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
                .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
        }
    }
}

/// The followed albums as big covers, Play all first; the rest of the albums below.
struct TVHome: View {
    @Environment(AlbumLibrary.self) private var albums
    @Binding var show: TVShow?
    @State private var settings = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 50) {
                HStack(alignment: .center, spacing: 30) {
                    Image("Mark").resizable().frame(width: 72, height: 72).clipShape(RoundedRectangle(cornerRadius: 16))
                    Text("Slide Station").font(.system(size: 56, weight: .bold))
                    Spacer()
                    if albums.loading { ProgressView() }
                    Button { settings = true } label: { Label("Settings", systemImage: "gearshape") }
                }
                let all = albums.followedPhotos
                if !all.isEmpty {
                    HStack(spacing: 30) {
                        Button { show = TVShow(photos: all, title: albums.followedAlbums.count == 1 ? albums.followedAlbums[0].name : nil, shuffle: SlideshowSettings.shuffle) } label: {
                            Label("Play \(all.count) slides", systemImage: "play.fill").padding(.horizontal, 20)
                        }
                        Button { show = TVShow(photos: all, start: Int.random(in: 0..<all.count), title: nil, shuffle: true) } label: {
                            Label("Shuffle", systemImage: "shuffle").padding(.horizontal, 20)
                        }
                    }
                }
                if !albums.followedAlbums.isEmpty { row("Your slideshow", albums.followedAlbums) }
                let others = albums.albums.filter { !albums.isFollowed($0.id) }
                if !others.isEmpty { row(albums.followedAlbums.isEmpty ? "Albums" : "More albums", others) }
                if albums.albums.isEmpty {
                    Text(albums.loading ? "Looking for albums…" : albums.problem ?? "This Immich account can't see any albums yet. Ask whoever has the slides to share their album with you.")
                        .font(.title3).foregroundStyle(.secondary)
                } else if let p = albums.problem {
                    Label(p, systemImage: "exclamationmark.triangle").foregroundStyle(ProTheme.warn)
                }
            }
            .padding(.horizontal, 80).padding(.vertical, 50)
        }
        .sheet(isPresented: $settings) { TVSettings() }
    }

    private func row(_ title: String, _ list: [ImmichAlbum]) -> some View {
        VStack(alignment: .leading, spacing: 24) {
            Text(title).font(.system(size: 34, weight: .semibold)).foregroundStyle(.secondary)
            ScrollView(.horizontal) {
                LazyHStack(spacing: 48) {
                    ForEach(list) { a in
                        NavigationLink(value: a) { TVAlbumCard(album: a) }.buttonStyle(.borderless)
                    }
                }
                .padding(.vertical, 30)
            }
            .scrollClipDisabled()
        }
    }
}

struct TVAlbumCard: View {
    @Environment(AlbumLibrary.self) private var albums
    let album: ImmichAlbum

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Group {
                if let c = album.coverID ?? albums.photos[album.id]?.first?.id {
                    RemotePhoto(c, size: .preview, maxPixel: 1000, client: albums.client)
                } else {
                    Rectangle().fill(ProTheme.canvas).overlay { Image(systemName: "photo.stack").font(.largeTitle) }
                }
            }
            .frame(width: 480, height: 320)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            Text(album.name).font(.system(size: 28, weight: .semibold)).lineLimit(1)
            Text("\(album.count) slides" + (album.sharedBy.map { " · from \($0)" } ?? "")).font(.system(size: 22)).foregroundStyle(.secondary)
        }
        .frame(width: 480, alignment: .leading)
    }
}

/// One album: Play and Shuffle, Follow, and every photo to start from.
struct TVAlbum: View {
    @Environment(AlbumLibrary.self) private var albums
    let album: ImmichAlbum
    @Binding var show: TVShow?
    /// Only the slides with this person.
    @State private var person: AlbumPerson?

    var body: some View {
        let all = albums.photos[album.id] ?? []
        let photos = person.map { who in all.filter { ($0.people ?? []).contains { $0.id == who.id } } } ?? all
        ScrollView {
            VStack(alignment: .leading, spacing: 40) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(album.name).font(.system(size: 56, weight: .bold))
                    Text(["\(photos.isEmpty && person == nil ? album.count : photos.count) slides", person.map { "with \($0.name)" }, ImmichDate.span(photos), album.sharedBy.map { "shared by \($0)" }]
                            .compactMap { $0 }.joined(separator: " · "))
                        .font(.title3).foregroundStyle(.secondary)
                }
                HStack(spacing: 30) {
                    Button { show = TVShow(photos: photos, title: person.map { "\(album.name) · \($0.name)" } ?? album.name, shuffle: false) } label: { Label("Play", systemImage: "play.fill").padding(.horizontal, 20) }
                        .disabled(photos.isEmpty)
                    Button { show = TVShow(photos: photos, start: Int.random(in: 0..<max(1, photos.count)), title: album.name, shuffle: true) } label: { Label("Shuffle", systemImage: "shuffle").padding(.horizontal, 20) }
                        .disabled(photos.isEmpty)
                    Button { albums.setFollowing(album.id, !albums.isFollowed(album.id)) } label: {
                        Label(albums.isFollowed(album.id) ? "In your slideshow" : "Add to your slideshow", systemImage: albums.isFollowed(album.id) ? "checkmark" : "plus")
                            .padding(.horizontal, 20)
                    }
                }
                let people = AlbumPerson.of(all)
                if !people.isEmpty {
                    ScrollView(.horizontal) {
                        HStack(spacing: 40) {
                            ForEach(people) { p in
                                let on = person?.id == p.id
                                Button { person = on ? nil : p } label: {
                                    VStack(spacing: 12) {
                                        FaceAvatar(photoID: p.photoID, box: p.box, client: albums.client, size: 150)
                                            .overlay { Circle().strokeBorder(on ? ProTheme.accent : .clear, lineWidth: 6) }
                                        Text(p.name).font(.system(size: 26, weight: on ? .semibold : .regular))
                                        Text("\(p.count) slides").font(.system(size: 20)).foregroundStyle(.secondary)
                                    }
                                }
                                .buttonStyle(.borderless)
                            }
                        }
                        .padding(.vertical, 20)
                    }
                    .scrollClipDisabled()
                }
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 40), count: 5), spacing: 40) {
                    ForEach(Array(photos.enumerated()), id: \.element.id) { i, p in
                        Button { show = TVShow(photos: photos, start: i, title: album.name, shuffle: false) } label: {
                            RemotePhoto(p.id, size: .thumbnail, maxPixel: 500, client: albums.client)
                                .frame(height: 210).frame(maxWidth: .infinity).clipped()
                        }
                        .buttonStyle(.card)
                    }
                }
                if photos.isEmpty { Text(albums.loading ? "Loading…" : "Nothing in this album yet.").foregroundStyle(.secondary) }
            }
            .padding(.horizontal, 80).padding(.vertical, 50)
        }
        .task { await albums.loadPhotos(album.id) }
    }
}

/// The server and API key, typed with the remote or the iPhone.
struct TVConnect: View {
    @Environment(AlbumLibrary.self) private var albums
    @State private var url = ""
    @State private var key = ""
    @State private var problem: String?
    @State private var busy = false

    var body: some View {
        HStack(alignment: .top, spacing: 80) {
            VStack(alignment: .leading, spacing: 24) {
                Image("Mark").resizable().frame(width: 96, height: 96).clipShape(RoundedRectangle(cornerRadius: 20))
                Text("Slide Station").font(.system(size: 64, weight: .bold))
                Text("Slides from your Immich albums, on the big screen.").font(.title3).foregroundStyle(.secondary)
                Text("Connected Slide Station on your iPhone, iPad or Mac already? The connection comes here through iCloud Keychain by itself: open this again in a moment.\n\nOtherwise, make an API key in Immich (your account → Account Settings → API Keys) with album.read, asset.read, asset.view and asset.download, and type it here. Your iPhone can type for you.")
                    .font(.system(size: 26)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: 820, alignment: .leading)
            VStack(alignment: .leading, spacing: 30) {
                TextField("Server, e.g. https://photos.example.com", text: $url)
                    .textContentType(.URL).keyboardType(.URL).autocorrectionDisabled().textInputAutocapitalization(.never)
                SecureField("API key", text: $key)
                Button {
                    busy = true
                    Task { problem = await albums.connect(ImmichConnection(url: url, key: key)); busy = false }
                } label: { HStack { Text("Connect"); if busy { ProgressView() } }.frame(maxWidth: .infinity) }
                    .disabled(url.isEmpty || key.isEmpty || busy)
                if let problem { Text(problem).foregroundStyle(ProTheme.destructive).fixedSize(horizontal: false, vertical: true) }
                Button("Check iCloud Keychain again") { Task { await albums.refresh() } }
            }
            .frame(width: 760)
        }
        .padding(80)
    }
}

struct TVSettings: View {
    @Environment(AlbumLibrary.self) private var albums
    @Environment(\.dismiss) private var dismiss
    @State private var interval = SlideshowSettings.interval
    @State private var shuffle = SlideshowSettings.shuffle
    @State private var captions = SlideshowSettings.captions

    var body: some View {
        NavigationStack {
            Form {
                Section("Slideshow") {
                    Picker("Each photo", selection: $interval) {
                        ForEach(SlideshowSettings.intervals, id: \.self) { s in Text(s < 60 ? "\(Int(s)) seconds" : "1 minute").tag(s) }
                    }
                    Toggle("Shuffle", isOn: $shuffle)
                    Toggle("Captions, dates and places", isOn: $captions)
                }
                Section("Albums in your slideshow") {
                    ForEach(albums.albums) { a in
                        Toggle(a.name + (a.sharedBy.map { " · from \($0)" } ?? ""), isOn: Binding(get: { albums.isFollowed(a.id) }, set: { albums.setFollowing(a.id, $0) }))
                    }
                }
                Section {
                    LabeledContent("Server", value: albums.connection.url)
                    if let s = albums.server { LabeledContent("Signed in as", value: s.user) }
                    Button("Disconnect", role: .destructive) { albums.disconnect(); dismiss() }
                }
            }
            .navigationTitle("Settings")
            .onChange(of: interval) { SlideshowSettings.interval = interval }
            .onChange(of: shuffle) { SlideshowSettings.shuffle = shuffle }
            .onChange(of: captions) { SlideshowSettings.captions = captions }
        }
    }
}
