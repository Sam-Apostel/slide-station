import Foundation

/// Minimal Immich client (Immich v1.118+ through v3) — `immich.py` over URLSession.
/// Facts that cost time (ARCHITECTURE.md §6): v1/v2 require `deviceAssetId` + `deviceId`, v3
/// rejects them; albums are found by name; re-uploads trash the old asset.
public struct ImmichClient: Sendable {
    public let base: URL
    let key: String
    let session: URLSession

    public init(url: String, key: String, session: URLSession = .shared) throws {
        var u = url.trimmingCharacters(in: .whitespacesAndNewlines)
        while u.hasSuffix("/") { u.removeLast() }
        if u.hasSuffix("/api") { u.removeLast(4) }
        guard !u.isEmpty, !key.isEmpty, let base = URL(string: u + "/api") else {
            throw SlideKitError.immich("Immich URL and API key are not set (Settings).")
        }
        self.base = base; self.key = key.trimmingCharacters(in: .whitespacesAndNewlines); self.session = session
    }

    func request(_ method: String, _ path: String, json: Any? = nil) throws -> URLRequest {
        var r = URLRequest(url: base.appendingPathComponent(path))
        r.httpMethod = method
        r.setValue(key, forHTTPHeaderField: "x-api-key")
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        r.timeoutInterval = 120
        if let json {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: json)
        }
        return r
    }

    func send(_ r: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: r)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        let path = r.url?.path ?? ""
        switch code {
        case 401: throw SlideKitError.immich("Immich rejected the API key (401).")
        case 403: throw SlideKitError.immich("The API key lacks a permission for \(path) (403). Give it asset.upload, asset.delete, album.read, album.create and albumAsset.create.")
        case 400...: throw SlideKitError.immich("Immich \(r.httpMethod ?? "") \(path) failed: \(code) \(String(decoding: data.prefix(300), as: UTF8.self))")
        default: return data
        }
    }

    func json(_ data: Data) throws -> Any { try JSONSerialization.jsonObject(with: data) }

    public struct Version: Sendable, Equatable { public var major: Int, minor: Int, patch: Int; public var text: String { "\(major).\(minor).\(patch)" } }

    public func version() async throws -> Version {
        let o = try json(try await send(request("GET", "server/version"))) as? [String: Any] ?? [:]
        return Version(major: o["major"] as? Int ?? 0, minor: o["minor"] as? Int ?? 0, patch: o["patch"] as? Int ?? 0)
    }

    public func whoami() async throws -> String {
        let o = try json(try await send(request("GET", "users/me"))) as? [String: Any] ?? [:]
        return (o["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (o["email"] as? String) ?? "?"
    }

    public func findOrCreateAlbum(_ name: String) async throws -> String {
        let albums = try json(try await send(request("GET", "albums"))) as? [[String: Any]] ?? []
        if let hit = albums.first(where: { $0["albumName"] as? String == name }), let id = hit["id"] as? String { return id }
        let o = try json(try await send(request("POST", "albums", json: ["albumName": name]))) as? [String: Any] ?? [:]
        guard let id = o["id"] as? String else { throw SlideKitError.immich("Immich didn't return an album id.") }
        return id
    }

    public func addToAlbum(_ albumID: String, assets: [String]) async throws {
        for chunk in stride(from: 0, to: assets.count, by: 200) {
            _ = try await send(request("PUT", "albums/\(albumID)/assets", json: ["ids": Array(assets[chunk..<min(assets.count, chunk + 200)])]))
        }
    }

    /// Upload a JPEG. Returns (asset id, status: created / duplicate / replaced).
    public func upload(jpeg: Data, filename: String, taken: Date, deviceAssetID: String, major: Int) async throws -> (String, String) {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let ts = f.string(from: taken)
        var fields = ["fileCreatedAt": ts, "fileModifiedAt": ts, "isFavorite": "false", "filename": filename]
        if major < 3 {  // v1/v2 require these, v3 rejects them
            fields["deviceAssetId"] = deviceAssetID
            fields["deviceId"] = "slide-station"
            fields["filename"] = nil
        }
        let boundary = "slidestation-\(UUID().uuidString)"
        var body = Data()
        for (k, v) in fields.sorted(by: { $0.key < $1.key }) {
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(k)\"\r\n\r\n\(v)\r\n".utf8))
        }
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"assetData\"; filename=\"\(filename)\"\r\nContent-Type: image/jpeg\r\n\r\n".utf8))
        body.append(jpeg)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        var r = try request("POST", "assets")
        r.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        r.httpBody = body
        let o = try json(try await send(r)) as? [String: Any] ?? [:]
        guard let id = o["id"] as? String else { throw SlideKitError.immich("Immich didn't return an asset id.") }
        return (id, o["status"] as? String ?? "created")
    }

    public func trash(_ assets: [String]) async throws {
        guard !assets.isEmpty else { return }
        _ = try await send(request("DELETE", "assets", json: ["ids": assets, "force": false]))
    }
}

/// Immich settings. The key lives in the Keychain, never in UserDefaults.
public struct ImmichSettings: Sendable, Equatable, Codable {
    public var url: String
    public var key: String
    public init(url: String = "", key: String = "") { self.url = url; self.key = key }
    public var isComplete: Bool { !url.trimmingCharacters(in: .whitespaces).isEmpty && !key.trimmingCharacters(in: .whitespaces).isEmpty }
}
