import Foundation

/// Reading and writing a library that lives in iCloud Drive (or another Files provider), shared
/// with the Mac app: files there can be cloud-only placeholders until asked for, and another device
/// may be writing them. Coordinated access makes the provider download first and not trip over a
/// sync in progress; on a plain folder it costs next to nothing.
public enum LocalFiles {
    /// A file's contents, downloading it first if it's only in the cloud.
    public static func read(_ url: URL) throws -> Data {
        startDownload(url)
        var out: Result<Data, Error> = .failure(CocoaError(.fileReadNoSuchFile))
        var err: NSError?
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &err) { u in
            out = Result { try Data(contentsOf: u) }
        }
        if let err { throw err }
        return try out.get()
    }

    public static func write(_ data: Data, to url: URL) throws {
        var out: Result<Void, Error> = .success(())
        var err: NSError?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &err) { u in
            out = Result { try data.write(to: u, options: .atomic) }
        }
        if let err { throw err }
        try out.get()
    }

    /// Download a file (or wait for it) without reading it.
    public static func materialize(_ url: URL) {
        var err: NSError?
        NSFileCoordinator().coordinate(readingItemAt: url, options: .withoutChanges, error: &err) { _ in }
    }

    static func startDownload(_ url: URL) {
        if isPlaceholder(url) { try? FileManager.default.startDownloadingUbiquitousItem(at: url) }
    }

    /// iCloud Drive keeps an evicted `name` as a hidden `.name.icloud` stub; other providers report
    /// it through the ubiquitous item status.
    static func isPlaceholder(_ url: URL) -> Bool {
        if !FileManager.default.fileExists(atPath: url.path) {
            return FileManager.default.fileExists(atPath: stub(for: url).path)
        }
        let v = try? url.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey])
        return v?.ubiquitousItemDownloadingStatus == .notDownloaded
    }

    static func stub(for url: URL) -> URL {
        url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).icloud")
    }

    /// Every file under `dir` that's still only in the cloud, by its real name.
    public static func placeholders(under dir: URL) -> [URL] {
        let keys: [URLResourceKey] = [.isRegularFileKey, .ubiquitousItemDownloadingStatusKey]
        guard let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: keys) else { return [] }
        var out: [URL] = []
        for case let u as URL in e {
            let n = u.lastPathComponent
            if n.hasPrefix("."), n.hasSuffix(".icloud") {
                out.append(u.deletingLastPathComponent().appendingPathComponent(String(n.dropFirst().dropLast(7))))
            } else if let v = try? u.resourceValues(forKeys: Set(keys)), v.isRegularFile == true,
                      v.ubiquitousItemDownloadingStatus == .notDownloaded {
                out.append(u)
            }
        }
        return out
    }

    /// Download `urls`, eight at a time; `progress` gets the number done so far.
    public static func download(_ urls: [URL], progress: @escaping @Sendable (Int) -> Void) async {
        for u in urls { try? FileManager.default.startDownloadingUbiquitousItem(at: u) }
        await withTaskGroup(of: Void.self) { group in
            var next = 0, done = 0
            func add() {
                guard next < urls.count else { return }
                let u = urls[next]
                next += 1
                group.addTask { materialize(u) }
            }
            for _ in 0..<8 { add() }
            while await group.next() != nil {
                done += 1
                progress(done)
                if Task.isCancelled { group.cancelAll(); return }
                add()
            }
        }
    }
}
