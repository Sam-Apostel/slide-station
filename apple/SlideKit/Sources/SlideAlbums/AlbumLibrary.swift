import Foundation
import Observation

/// Album lists on disk: what the app last fetched, so albums open instantly and offline, and the
/// widget has something to show without asking Immich first.
public enum AlbumCache {
    private static var folder: URL { SharedStore.folder.appendingPathComponent("Lists", isDirectory: true) }

    struct Stored<T: Codable>: Codable { var fetched: Date; var value: T }

    static func read<T: Codable>(_ name: String, as: T.Type) -> (T, Date)? {
        guard let d = try? Data(contentsOf: folder.appendingPathComponent(name + ".json")),
              let s = try? JSONDecoder().decode(Stored<T>.self, from: d) else { return nil }
        return (s.value, s.fetched)
    }

    static func write<T: Codable>(_ name: String, _ value: T) {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        if let d = try? JSONEncoder().encode(Stored(fetched: Date(), value: value)) {
            try? d.write(to: folder.appendingPathComponent(name + ".json"), options: .atomic)
        }
    }

    public static func albums() -> [ImmichAlbum]? { read("albums", as: [ImmichAlbum].self)?.0 }
    public static func photos(_ albumID: String) -> (photos: [AlbumPhoto], fetched: Date)? { read("album-" + albumID, as: [AlbumPhoto].self) }
    public static func save(albums: [ImmichAlbum]) { write("albums", albums) }
    public static func save(_ photos: [AlbumPhoto], of albumID: String) { write("album-" + albumID, photos) }

    /// The followed albums' photos, fetched again when older than `maxAge` (the widget: hours).
    public static func followedPhotos(maxAge: TimeInterval, client: AlbumClient?) async -> [AlbumPhoto] {
        var out: [AlbumPhoto] = []
        for id in SharedStore.followed {
            let cached = photos(id)
            if let client, cached.map({ -$0.fetched.timeIntervalSinceNow > maxAge }) ?? true,
               let fresh = try? await client.photos(in: id) {
                save(fresh, of: id)
                out += fresh
            } else {
                out += cached?.photos ?? []
            }
        }
        return out
    }
}

/// How slideshows play (all devices: the iPhone, the Mac, the TV).
public enum SlideshowSettings {
    /// Seconds per photo.
    public static var interval: Double {
        get { (SharedStore.defaults.object(forKey: "slideshowInterval") as? Double) ?? 8 }
        set { SharedStore.defaults.set(newValue, forKey: "slideshowInterval") }
    }
    public static var shuffle: Bool {
        get { SharedStore.defaults.bool(forKey: "slideshowShuffle") }
        set { SharedStore.defaults.set(newValue, forKey: "slideshowShuffle") }
    }
    /// Caption, date and place over the photo.
    public static var captions: Bool {
        get { (SharedStore.defaults.object(forKey: "slideshowCaptions") as? Bool) ?? true }
        set { SharedStore.defaults.set(newValue, forKey: "slideshowCaptions") }
    }
    public static let intervals: [Double] = [5, 8, 12, 20, 30, 60]
}

/// The albums side of the apps: the Immich connection, every album it can see, the ones followed
/// and their photos. One per app, on the main actor; views observe it.
@MainActor @Observable
public final class AlbumLibrary {
    public private(set) var connection: ImmichConnection
    public private(set) var server: AlbumClient.Server?
    /// Every album the key can see, own and shared, newest change first.
    public private(set) var albums: [ImmichAlbum]
    /// Followed album ids, in the order they were chosen.
    public private(set) var followed: [String]
    public private(set) var photos: [String: [AlbumPhoto]] = [:]
    public private(set) var loading = false
    /// Why the last refresh failed (nil: it didn't, or nothing was tried).
    public private(set) var problem: String?

    /// Called after anything the widget shows changes (the iOS app reloads its timelines).
    @ObservationIgnored public var onChange: (() -> Void)?

    public init() {
        connection = ImmichKeychain.load() ?? ImmichConnection()
        albums = AlbumCache.albums() ?? []
        followed = SharedStore.followed
        for id in followed { if let c = AlbumCache.photos(id) { photos[id] = c.photos } }
    }

    public var isConnected: Bool { connection.isComplete }
    public var client: AlbumClient? { try? AlbumClient(connection) }

    public var followedAlbums: [ImmichAlbum] { followed.compactMap { id in albums.first { $0.id == id } } }
    /// Every followed album's photos, album after album.
    public var followedPhotos: [AlbumPhoto] { followed.flatMap { photos[$0] ?? [] } }

    public func album(_ id: String) -> ImmichAlbum? { albums.first { $0.id == id } }

    // MARK: connecting

    /// Check a server and key, and keep them when they work. Returns what went wrong, or nil.
    @discardableResult
    public func connect(_ c: ImmichConnection) async -> String? {
        do {
            let s = try await AlbumClient(c).server()
            if c != connection {
                // another server or account: its albums aren't these
                albums = []; photos = [:]; followed = []
                SharedStore.followed = []; SharedStore.choseAlbums = false
                AlbumCache.save(albums: [])
            }
            connection = c
            ImmichKeychain.save(c)
            server = s
            problem = nil
            await refresh()
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// Keep a server and key as typed, untested (Settings' Done), and look at its albums.
    public func use(_ c: ImmichConnection) {
        guard c != connection else { return }
        guard c.isComplete else { disconnect(); return }
        albums = []; photos = [:]; followed = []; server = nil; problem = nil
        SharedStore.followed = []; SharedStore.choseAlbums = false
        AlbumCache.save(albums: [])
        connection = c
        ImmichKeychain.save(c)
        Task { await refresh() }
    }

    /// Forget the server and key (on every device that syncs the keychain).
    public func disconnect() {
        connection = ImmichConnection()
        ImmichKeychain.save(connection)
        server = nil; albums = []; photos = [:]; followed = []; problem = nil
        SharedStore.followed = []; SharedStore.choseAlbums = false
        AlbumCache.save(albums: [])
        onChange?()
    }

    /// The keychain may have changed on another device (iCloud Keychain) or in Settings.
    public func reloadConnection() {
        let c = ImmichKeychain.load() ?? ImmichConnection()
        if c != connection { connection = c; server = nil }
    }

    // MARK: refreshing

    /// Fetch the album list and the followed albums' photos again. Albums others shared with this
    /// account are followed by themselves the first time: that's why they were shared.
    public func refresh() async {
        reloadConnection()
        guard let client, !loading else { return }
        loading = true
        defer { loading = false }
        do {
            if server == nil { server = try await client.server() }
            let all = try await client.albums(me: server?.userID)
            albums = all.sorted { ($0.updated ?? .distantPast) > ($1.updated ?? .distantPast) }
            AlbumCache.save(albums: albums)
            if !SharedStore.choseAlbums {
                let shared = albums.filter { $0.sharedBy != nil }.map(\.id)
                if !shared.isEmpty { setFollowed(shared, chosen: true) }
            }
            // albums that are gone (deleted, unshared) stop being followed
            let known = Set(albums.map(\.id))
            if followed.contains(where: { !known.contains($0) }) { setFollowed(followed.filter(known.contains), chosen: SharedStore.choseAlbums) }
            for id in followed { await loadPhotos(id, client: client) }
            problem = nil
        } catch {
            problem = error.localizedDescription
        }
        onChange?()
        await PhotoImages.shared.trim()
    }

    /// One album's photos (followed or only being looked at).
    public func loadPhotos(_ albumID: String) async {
        guard let client else { return }
        if photos[albumID] == nil, let c = AlbumCache.photos(albumID) { photos[albumID] = c.photos }
        await loadPhotos(albumID, client: client)
    }

    private func loadPhotos(_ albumID: String, client: AlbumClient) async {
        do {
            let p = try await client.photos(in: albumID)
            photos[albumID] = p
            AlbumCache.save(p, of: albumID)
        } catch {
            problem = error.localizedDescription
        }
    }

    // MARK: following

    public func isFollowed(_ id: String) -> Bool { followed.contains(id) }

    public func setFollowing(_ id: String, _ on: Bool) {
        var f = followed.filter { $0 != id }
        if on { f.append(id) }
        setFollowed(f, chosen: true)
        if on, photos[id] == nil { Task { await loadPhotos(id) } }
    }

    private func setFollowed(_ ids: [String], chosen: Bool) {
        followed = ids
        SharedStore.followed = ids
        if chosen { SharedStore.choseAlbums = true }
        onChange?()
    }
}
