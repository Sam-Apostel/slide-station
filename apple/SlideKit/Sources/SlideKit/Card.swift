import Foundation

/// The scanner's card, reached through the Files app.
///
/// iPadOS mounts the Slide N Scan's storage as a USB drive in Files, but gives apps no "drive
/// mounted" event and no path. The user picks the card's folder once; the app keeps a bookmark to
/// it and checks whether it resolves whenever the app becomes active.
public struct CardSource: Sendable, Equatable {
    public var url: URL
    public var name: String
    public var count: Int
    public var new: Int
    public var scanner: Bool

    public static let scannerModels: Set<String> = ["RODFS50"]   // Kodak Slide N Scan
    public static let scannerMakes: Set<String> = ["GCMC"]

    /// JPEGs under DCIM (or under the folder itself when there is no DCIM), sorted by path.
    public static func jpegs(in root: URL) -> [URL] {
        let dcim = root.appendingPathComponent("DCIM", isDirectory: true)
        var isDir: ObjCBool = false
        let base = FileManager.default.fileExists(atPath: dcim.path, isDirectory: &isDir) && isDir.boolValue ? dcim : root
        guard let e = FileManager.default.enumerator(at: base, includingPropertiesForKeys: [.isRegularFileKey],
                                                     options: [.skipsHiddenFiles]) else { return [] }
        var out: [URL] = []
        for case let url as URL in e {
            let n = url.lastPathComponent
            if !n.hasPrefix("._"), ["jpg", "jpeg"].contains(url.pathExtension.lowercased()) { out.append(url) }
        }
        return out.sorted { $0.path < $1.path }
    }

    public static func hasDCIM(_ root: URL) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: root.appendingPathComponent("DCIM").path, isDirectory: &isDir) && isDir.boolValue
    }

    /// "name:size:mtime" — the cheap identity used to tell new scans from imported ones.
    public static func quickFingerprint(_ url: URL) -> String? {
        guard let a = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = a[.size] as? Int, let m = a[.modificationDate] as? Date else { return nil }
        return "\(url.lastPathComponent):\(size):\(Int(m.timeIntervalSince1970))"
    }

    /// Look at a folder the way `workflow.detect_sources` looks at a mounted volume.
    public static func inspect(_ root: URL, index: Library.ImportedIndex) -> CardSource {
        let files = jpegs(in: root)
        let info = files.first.map(ImageFile.info) ?? ImageFile.Info()
        let new = files.filter { quickFingerprint($0).map { index.fp[$0] == nil } ?? false }.count
        return CardSource(url: root, name: root.lastPathComponent, count: files.count, new: new,
                          scanner: scannerModels.contains(info.model) || scannerMakes.contains(info.make))
    }
}

/// Remembers the card folder across launches (a security-scoped bookmark).
public struct CardBookmark: Sendable {
    public let key: String
    public init(key: String = "cardBookmark") { self.key = key }

    public func save(_ url: URL) throws {
        #if os(macOS)
        let data = try url.bookmarkData(options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil)
        #else
        let data = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        #endif
        UserDefaults.standard.set(data, forKey: key)
    }

    public func forget() { UserDefaults.standard.removeObject(forKey: key) }

    public var isSet: Bool { UserDefaults.standard.data(forKey: key) != nil }

    /// The card's URL if it is plugged in right now. Call `startAccessingSecurityScopedResource`
    /// on it before reading (and stop afterwards).
    public func resolve() -> URL? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        var stale = false
        #if os(macOS)
        let url = try? URL(resolvingBookmarkData: data, options: .withSecurityScope, relativeTo: nil, bookmarkDataIsStale: &stale)
        #else
        let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
        #endif
        guard let url else { return nil }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard (try? url.checkResourceIsReachable()) == true else { return nil }
        if stale { try? save(url) }
        return url
    }
}
