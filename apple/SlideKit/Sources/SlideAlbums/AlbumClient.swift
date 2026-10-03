import Foundation

public enum AlbumError: LocalizedError, Equatable {
    case notSet
    case badKey
    case permission(String)
    case server(String)
    case unreachable(String)

    public var errorDescription: String? {
        switch self {
        case .notSet: "Add the Immich server and an API key first."
        case .badKey: "Immich didn't accept the API key. Check it in Immich under Account Settings → API Keys."
        case .permission(let path): "The API key isn't allowed to read \(path). Give it album.read, asset.read, asset.view and asset.download."
        case .server(let s): s
        case .unreachable(let s): "Couldn't reach the Immich server: \(s)"
        }
    }
}

/// Reading albums from Immich (v1.118 through v3), for looking at slides: the albums this key can
/// see, the photos in one, and their images. The permissions it needs: `album.read`, `asset.read`,
/// `asset.view` (thumbnails and previews) and `asset.download` (full size on the TV).
public struct AlbumClient: Sendable {
    public let base: URL
    let key: String
    let session: URLSession

    public init(_ c: ImmichConnection, session: URLSession = AlbumClient.session) throws {
        var u = c.url.trimmingCharacters(in: .whitespacesAndNewlines)
        while u.hasSuffix("/") { u.removeLast() }
        if u.hasSuffix("/api") { u.removeLast(4) }
        if !u.isEmpty, !u.contains("://") { u = "http://" + u }   // "immich.local:2283" as people type it
        let key = c.key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !u.isEmpty, !key.isEmpty, let base = URL(string: u + "/api") else { throw AlbumError.notSet }
        self.base = base; self.key = key; self.session = session
    }

    /// No URLCache: images are cached by `PhotoImages`, lists by `AlbumCache`.
    public static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.urlCache = nil
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForRequest = 30
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    // MARK: requests

    private func request(_ method: String, _ path: String, query: [String: String] = [:], json: Any? = nil) throws -> URLRequest {
        var comps = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { comps.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var r = URLRequest(url: comps.url!)
        r.httpMethod = method
        r.setValue(key, forHTTPHeaderField: "x-api-key")
        if let json {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: json)
        }
        return r
    }

    private func send(_ r: URLRequest) async throws -> (Data, Int) {
        let data: Data, response: URLResponse
        do { (data, response) = try await session.data(for: r) } catch let e as URLError where e.code != .cancelled {
            throw AlbumError.unreachable(e.localizedDescription)
        }
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        switch code {
        case 401: throw AlbumError.badKey
        case 403: throw AlbumError.permission(r.url?.path.replacingOccurrences(of: base.path, with: "") ?? "")
        default: return (data, code)
        }
    }

    private func json(_ method: String, _ path: String, query: [String: String] = [:], body: Any? = nil) async throws -> Any {
        let r = try request(method, path, query: query, json: body)
        let (data, code) = try await send(r)
        guard code < 400 else { throw AlbumError.server("Immich \(method) /\(path) failed: \(code) \(String(decoding: data.prefix(200), as: UTF8.self))") }
        do { return try JSONSerialization.jsonObject(with: data) } catch {
            throw AlbumError.server("That doesn't look like an Immich server (\(r.url?.host() ?? "")).")
        }
    }

    // MARK: server

    public struct Server: Sendable, Equatable {
        public var major: Int, minor: Int
        public var user: String
        public var userID: String?
    }

    /// The server's version and who the key belongs to: checks the URL and the key at once.
    public func server() async throws -> Server {
        let v = try await json("GET", "server/version") as? [String: Any] ?? [:]
        let me = try await json("GET", "users/me") as? [String: Any] ?? [:]
        let name = (me["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (me["email"] as? String) ?? "?"
        return Server(major: v["major"] as? Int ?? 0, minor: v["minor"] as? Int ?? 0, user: name, userID: me["id"] as? String)
    }

    // MARK: albums

    /// Every album this key can see. `GET /albums` answers the account's own; albums others shared
    /// with it only come with `shared=true` (the same in v1 through v3).
    public func albums(me: String?) async throws -> [ImmichAlbum] {
        let own = try await json("GET", "albums") as? [[String: Any]] ?? []
        let shared = try await json("GET", "albums", query: ["shared": "true"]) as? [[String: Any]] ?? []
        var seen = Set<String>()
        return (own + shared).compactMap { ImmichAlbum(json: $0, me: me) }.filter { seen.insert($0.id).inserted }
    }

    /// The photos in an album, oldest first: that's tray order, since Slide Station dates each
    /// slide a minute after the one before it. v1/v2 list them in `GET /albums/{id}`; v3 doesn't,
    /// so the album is searched (`albumIds`, paged by `nextPage` before 3.2 and `nextCursor` since).
    public func photos(in albumID: String) async throws -> [AlbumPhoto] {
        let album = try await json("GET", "albums/\(albumID)") as? [String: Any] ?? [:]
        var raw = album["assets"] as? [[String: Any]] ?? []
        if raw.isEmpty, (album["assetCount"] as? Int ?? 1) > 0 {
            var body: [String: Any] = ["albumIds": [albumID], "size": 1000, "withExif": true]
            for _ in 0..<1000 {
                let o = try await json("POST", "search/metadata", body: body) as? [String: Any] ?? [:]
                let page = o["assets"] as? [String: Any] ?? [:]
                raw += page["items"] as? [[String: Any]] ?? []
                if let cursor = page["nextCursor"] as? String, !cursor.isEmpty {
                    body["page"] = nil; body["cursor"] = cursor
                } else if let next = page["nextPage"] as? String, let n = Int(next) {
                    body["page"] = n
                } else { break }
            }
        }
        return Self.ordered(raw.compactMap { AlbumPhoto(json: $0, albumID: albumID) })
    }

    /// Oldest first; undated photos at the end, in the order Immich gave them.
    static func ordered(_ photos: [AlbumPhoto]) -> [AlbumPhoto] {
        photos.enumerated().sorted { a, b in
            switch (a.element.taken, b.element.taken) {
            case let (x?, y?): x == y ? a.offset < b.offset : x < y
            case (.some, nil): true
            case (nil, .some): false
            case (nil, nil): a.offset < b.offset
            }
        }.map(\.element)
    }

    // MARK: images

    public enum Size: String, Sendable, CaseIterable {
        /// ~250 px: grids.
        case thumbnail
        /// ~1440 px: a phone or iPad screen, the widget.
        case preview
        /// The photo at full size (v1.133+); a big screen.
        case fullsize
    }

    /// The image bytes (JPEG or WebP) at `size`, falling back to the next smaller rendition the
    /// server has, then to the original. Older servers have no `fullsize`; some setups don't
    /// generate previews.
    public func image(_ id: String, size: Size) async throws -> Data {
        let chain: [Size] = switch size {
        case .thumbnail: [.thumbnail]
        case .preview: [.preview]   // then the original: a thumbnail is too small to fill a screen
        case .fullsize: [.fullsize, .preview]
        }
        var last: Error = AlbumError.server("Immich has no image for this photo.")
        for s in chain {
            let (data, code) = try await send(try request("GET", "assets/\(id)/thumbnail", query: ["size": s.rawValue]))
            if code < 400, !data.isEmpty { return data }
            last = AlbumError.server("Immich couldn't give a \(s.rawValue) of this photo (\(code)).")
        }
        // the original as uploaded (a Slide Station JPEG): needs asset.download
        let (data, code) = try await send(try request("GET", "assets/\(id)/original"))
        if code < 400, !data.isEmpty { return data }
        throw last
    }
}
