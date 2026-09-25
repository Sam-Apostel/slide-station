import CryptoKit
import Foundation

/// The on-device library: the same layout as the Python app's library folder, so a tray folder can
/// move between the two. `<root>/sessions/<id>/{session.json, originals/, cache/}` plus
/// `<root>/imported.json` (sha1 → tray id, and `_fp`: quick fingerprint → sha1) for dedupe.
///
/// An actor: every change goes through `update(_:_:)`, which reloads, applies and saves — the
/// Swift form of `workflow.update_session`, so slow work never writes back a stale tray.
public actor Library {
    public nonisolated let root: URL
    private var cache: [String: Tray] = [:]
    /// Each tray's file as last read or written, and the typed tray as JSON then (see `write`).
    private var files: [String: (raw: JSONValue, base: JSONValue)] = [:]

    public init(root: URL) throws {
        self.root = root
        try FileManager.default.createDirectory(at: root.appendingPathComponent("sessions"), withIntermediateDirectories: true)
    }

    /// The app's default library in Application Support (backed up, not visible in Files).
    public static func defaultRoot() -> URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Slide Station", isDirectory: true)
    }

    // MARK: paths

    public nonisolated func trayDir(_ id: String) -> URL { root.appendingPathComponent("sessions/\(id)", isDirectory: true) }
    public nonisolated func originals(_ id: String) -> URL { trayDir(id).appendingPathComponent("originals", isDirectory: true) }
    public nonisolated func cacheDir(_ id: String) -> URL { trayDir(id).appendingPathComponent("cache", isDirectory: true) }
    public nonisolated func originalURL(_ tray: Tray, scan: String) -> URL? {
        tray.scans[scan].map { originals(tray.id).appendingPathComponent($0.file) }
    }

    // MARK: trays

    /// A new, empty tray; in a box (a free side of it), named after where it lives unless given a name.
    public func createTray(name: String, album: String? = nil, date: String = "", box: Int? = nil, side: Tray.Side? = nil) throws -> Tray {
        try checkFree(box: box, side: side)
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd-HHmmss"
        f.locale = Locale(identifier: "en_US_POSIX")
        let id = f.string(from: Date()) + "-" + String(UUID().uuidString.lowercased().prefix(4))
        for sub in ["originals", "cache"] {
            try FileManager.default.createDirectory(at: trayDir(id).appendingPathComponent(sub), withIntermediateDirectories: true)
        }
        let tray = Tray(id: id, name: name, album: album, date: date, box: box, side: side)
        if let box { try saveBox(box) }
        try write(tray)
        return tray
    }

    /// Put a tray in box `box` as its `side` tray (nil, nil: out of its box). A name or album that
    /// only said where it was moves with it; one you gave it stays (Python: `patch_session`).
    @discardableResult
    public func move(_ id: String, box: Int?, side: Tray.Side?) throws -> Tray {
        try checkFree(box: box, side: side, besides: id)
        if let box { try saveBox(box) }
        return try update(id) { t in
            let old = t.placeLabel, new = Tray.label(box: box, side: side)
            if !old.isEmpty, !new.isEmpty {
                if t.name == old { t.name = new }
                if t.album == old { t.album = new }
            }
            t.box = box; t.side = side
        }
    }

    /// One tray per side of a box.
    private func checkFree(box: Int?, side: Tray.Side?, besides id: String? = nil) throws {
        if let box, box < 1 { throw BoxError.badNumber }
        guard let box, let side else { return }
        if let there = trays().first(where: { $0.id != id && $0.box == box && $0.side == side }) {
            throw BoxError.taken(Tray.label(box: box, side: side), by: there.name)
        }
    }

    // MARK: boxes

    /// Box number -> its size and writing (`boxes.json`, as the Python app writes it).
    public func boxes() -> [Int: Box] {
        guard let data = try? LocalFiles.read(root.appendingPathComponent("boxes.json")),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = obj["boxes"] as? [String: [String: Any]] else { return [:] }
        var out: [Int: Box] = [:]
        for (k, v) in raw {
            guard let n = Int(k) else { continue }
            out[n] = Box(number: n, size: v["size"] as? Int ?? Box.sizes[0], writing: v["writing"] as? String ?? "")
        }
        return out
    }

    /// Create or change box `number`; what's not given stays (a new box holds trays of 50).
    @discardableResult
    public func saveBox(_ number: Int, size: Int? = nil, writing: String? = nil) throws -> Box {
        if number < 1 { throw BoxError.badNumber }
        if let size, !Box.sizes.contains(size) { throw BoxError.badSize }
        var all = boxes()
        var b = all[number] ?? Box(number: number)
        if let size { b.size = size }
        if let writing { b.writing = writing }
        all[number] = b
        // keys sort as strings, like Python's json.dumps of str keys would read back: order doesn't matter
        let obj: [String: Any] = ["boxes": Dictionary(uniqueKeysWithValues: all.map { (String($0.key), ["size": $0.value.size, "writing": $0.value.writing] as [String: Any]) })]
        try LocalFiles.write(JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .prettyPrinted]), to: root.appendingPathComponent("boxes.json"))
        return b
    }

    public func trays() -> [Tray] {
        let dirs = (try? FileManager.default.contentsOfDirectory(at: root.appendingPathComponent("sessions"), includingPropertiesForKeys: [.isDirectoryKey])) ?? []
        return dirs.filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            .compactMap { try? load($0.lastPathComponent) }.sorted { $0.id > $1.id }
    }

    public func load(_ id: String) throws -> Tray {
        let url = trayDir(id).appendingPathComponent("session.json")
        let data = try LocalFiles.read(url)
        let tray = try JSONDecoder().decode(Tray.self, from: data)
        files[id] = (try JSONValue.parse(data), try Library.json(tray))
        cache[id] = tray
        return tray
    }

    /// Reload, apply, save. The only way trays change.
    @discardableResult
    public func update(_ id: String, _ change: (inout Tray) throws -> Void) throws -> Tray {
        var tray = try load(id)
        try change(&tray)
        try write(tray)
        return tray
    }

    public func deleteTray(_ id: String) throws {
        try FileManager.default.removeItem(at: trayDir(id))
        cache[id] = nil
        var idx = importedIndex()
        idx.sha = idx.sha.filter { $0.value != id }
        try saveIndex(idx)
    }

    /// Writes back through `JSONValue.merge`: what the Python app wrote and this app doesn't model
    /// (or didn't change) stays exactly as it was.
    private func write(_ tray: Tray) throws {
        let new = try Library.json(tray)
        let out = files[tray.id].map { JSONValue.merge(raw: $0.raw, base: $0.base, new: new) } ?? new
        try LocalFiles.write(out.serialized(), to: trayDir(tray.id).appendingPathComponent("session.json"))
        files[tray.id] = (out, new)
        cache[tray.id] = tray
    }

    /// A tray as the JSON it's written as; develop settings as floats, like Python writes them.
    static func json(_ tray: Tray) throws -> JSONValue {
        guard case .object(var o) = try JSONValue.encode(tray) else { return .null }
        o["defaults"] = o["defaults"]?.floats
        if case .array(let groups) = o["groups"] {
            o["groups"] = .array(groups.map { g in
                guard case .object(var g) = g else { return g }
                g["params"] = g["params"]?.floats
                if case .object(var h) = g["history"] {
                    for side in ["undo", "redo"] {
                        if case .array(let snaps) = h[side] {
                            h[side] = .array(snaps.map { s in
                                guard case .object(var s) = s else { return s }
                                s["params"] = s["params"]?.floats
                                return .object(s)
                            })
                        }
                    }
                    g["history"] = .object(h)
                }
                return .object(g)
            })
        }
        return .object(o)
    }

    // MARK: files not on this device yet (iCloud Drive and other providers)

    /// Files of a tray that are still only in the cloud.
    public nonisolated func notDownloaded(_ id: String) -> [URL] { LocalFiles.placeholders(under: trayDir(id)) }

    /// Fetch them, several at a time.
    public nonisolated func download(_ urls: [URL], progress: @escaping @Sendable (Int) -> Void) async {
        await LocalFiles.download(urls, progress: progress)
    }

    // MARK: dedupe index

    public struct ImportedIndex: Sendable {
        public var sha: [String: String] = [:]   // sha1 -> tray id
        public var fp: [String: String] = [:]    // "name:size:mtime" -> sha1
    }

    public func importedIndex() -> ImportedIndex {
        guard let data = try? LocalFiles.read(root.appendingPathComponent("imported.json")),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return ImportedIndex() }
        var idx = ImportedIndex()
        for (k, v) in obj {
            if k == "_fp", let fp = v as? [String: String] { idx.fp = fp } else if let s = v as? String { idx.sha[k] = s }
        }
        return idx
    }

    public func addToIndex(sha: [String: String], fp: [String: String]) throws {
        var idx = importedIndex()
        idx.sha.merge(sha) { _, new in new }
        idx.fp.merge(fp) { _, new in new }
        try saveIndex(idx)
    }

    private func saveIndex(_ idx: ImportedIndex) throws {
        var obj: [String: Any] = idx.sha
        obj["_fp"] = idx.fp
        try LocalFiles.write(JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]), to: root.appendingPathComponent("imported.json"))
    }
}

/// A numbered box of two trays, left and right: trays of 50, or 36 in the shorter boxes. A box can
/// have writing on it; a tray can't. Python: `store.load_boxes`.
public struct Box: Equatable, Sendable {
    public static let sizes = [50, 36]
    public var number: Int
    /// Slides a tray of it holds.
    public var size: Int = Box.sizes[0]
    /// What's written on the box ("" = nothing).
    public var writing: String = ""
    public init(number: Int, size: Int = Box.sizes[0], writing: String = "") {
        self.number = number; self.size = size; self.writing = writing
    }
}

public enum BoxError: LocalizedError, Equatable {
    case badNumber, badSize
    case taken(String, by: String)
    public var errorDescription: String? {
        switch self {
        case .badNumber: "A box number is a whole number: 1, 2, 3…"
        case .badSize: "A box holds trays of 50 or 36 slides"
        case .taken(let place, let name): "\(place) is already the tray \"\(name)\""
        }
    }
}

public func sha1(of url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = Insecure.SHA1()
    while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}
