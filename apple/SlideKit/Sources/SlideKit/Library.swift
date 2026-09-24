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

    public func createTray(name: String, album: String? = nil, date: String = "") throws -> Tray {
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd-HHmmss"
        f.locale = Locale(identifier: "en_US_POSIX")
        let id = f.string(from: Date()) + "-" + String(UUID().uuidString.lowercased().prefix(4))
        for sub in ["originals", "cache"] {
            try FileManager.default.createDirectory(at: trayDir(id).appendingPathComponent(sub), withIntermediateDirectories: true)
        }
        let tray = Tray(id: id, name: name, album: album, date: date)
        try write(tray)
        return tray
    }

    public func trays() -> [Tray] {
        let dirs = (try? FileManager.default.contentsOfDirectory(at: root.appendingPathComponent("sessions"), includingPropertiesForKeys: nil)) ?? []
        return dirs.compactMap { try? load($0.lastPathComponent) }.sorted { $0.id > $1.id }
    }

    public func load(_ id: String) throws -> Tray {
        let data = try Data(contentsOf: trayDir(id).appendingPathComponent("session.json"))
        let tray = try JSONDecoder().decode(Tray.self, from: data)
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

    private func write(_ tray: Tray) throws {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try enc.encode(tray).write(to: trayDir(tray.id).appendingPathComponent("session.json"), options: .atomic)
        cache[tray.id] = tray
    }

    // MARK: dedupe index

    public struct ImportedIndex: Sendable {
        public var sha: [String: String] = [:]   // sha1 -> tray id
        public var fp: [String: String] = [:]    // "name:size:mtime" -> sha1
    }

    public func importedIndex() -> ImportedIndex {
        guard let data = try? Data(contentsOf: root.appendingPathComponent("imported.json")),
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
        try JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]).write(to: root.appendingPathComponent("imported.json"), options: .atomic)
    }
}

public func sha1(of url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = Insecure.SHA1()
    while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}
