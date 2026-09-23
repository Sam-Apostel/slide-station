import Foundation
import ImageIO

/// Full-resolution render with EXIF, then upload to the tray's Immich album —
/// `workflow.render_export` + `workflow.finish_session`.
public struct Uploader: Sendable {
    public let library: Library
    public var jpegQuality = 0.95

    public init(library: Library) { self.library = library }

    /// The date a slide goes to Immich with: its own or estimated date at noon, one minute per
    /// slide to keep tray order; the scan's EXIF time when nothing is known.
    public static func photoDate(_ tray: Tray, index: Int, estimated: [SlideDate]) -> Date {
        if let (d, _) = SlideDates.parse(estimated[index].value) {
            return d.addingTimeInterval(12 * 3600 + 60 * Double(index))
        }
        let f = DateFormatter()
        f.dateFormat = "yyyy:MM:dd HH:mm:ss"
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        let scan = tray.groups[index].activeScans[0]
        return tray.scans[scan].flatMap { f.date(from: $0.taken) } ?? Date()
    }

    /// Render one slide at full resolution as JPEG bytes with the date and caption in EXIF.
    public func render(_ tray: Tray, index: Int, estimated: [SlideDate]) throws -> Data {
        let g = tray.groups[index]
        let urls = g.activeScans.compactMap { library.originalURL(tray, scan: $0) }
        guard urls.count == g.activeScans.count, urls.allSatisfy({ FileManager.default.fileExists(atPath: $0.path) }) else {
            throw SlideKitError.originalsMissing
        }
        var a = Fusion.fuse(try urls.map { try ImageFile.load($0) })
        a = Develop.develop(a.rotated(g.rotation), g.params)

        var props: [CFString: Any] = [:]
        if let src = CGImageSourceCreateWithURL(urls[0] as CFURL, nil),
           let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] {
            for k in [kCGImagePropertyExifDictionary, kCGImagePropertyTIFFDictionary] { if let v = p[k] { props[k] = v } }
        }
        let f = DateFormatter()
        f.dateFormat = "yyyy:MM:dd HH:mm:ss"
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        let when = f.string(from: Uploader.photoDate(tray, index: index, estimated: estimated))
        var tiff = props[kCGImagePropertyTIFFDictionary] as? [CFString: Any] ?? [:]
        tiff[kCGImagePropertyTIFFOrientation] = 1          // pixels are already upright
        tiff[kCGImagePropertyTIFFSoftware] = "Slide Station"
        tiff[kCGImagePropertyTIFFDateTime] = when
        if let c = g.caption, !c.isEmpty { tiff[kCGImagePropertyTIFFImageDescription] = c }  // Immich's description
        var exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any] ?? [:]
        exif[kCGImagePropertyExifDateTimeOriginal] = when   // what Immich puts on the timeline
        exif[kCGImagePropertyExifDateTimeDigitized] = when
        exif[kCGImagePropertyExifPixelXDimension] = a.width
        exif[kCGImagePropertyExifPixelYDimension] = a.height
        props[kCGImagePropertyTIFFDictionary] = tiff
        props[kCGImagePropertyExifDictionary] = exif
        props[kCGImagePropertyOrientation] = 1
        return try ImageFile.jpeg(a, quality: jpegQuality, properties: props)
    }

    public struct Result: Sendable, Equatable { public var uploaded = 0, lost = 0; public var album = "" }

    /// Upload every slide that isn't skipped or already up to date (`onlyReady`: just the developed ones).
    public func finish(trayID: String, settings: ImmichSettings, onlyReady: Bool,
                       progress: @Sendable (JobProgress) -> Void = { _ in }) async throws -> Result {
        let client = try ImmichClient(url: settings.url, key: settings.key)
        var tray = try await library.load(trayID)
        let redate = tray.dateKey != tray.date
        let statuses = tray.statuses()
        var todo = tray.groups.enumerated().filter { i, g in
            !g.skip && (redate || statuses[i] != .uploaded) && (g.reviewed || !onlyReady)
        }.map(\.element.id)
        let lost = todo.filter { id in
            guard let g = tray.groups.first(where: { $0.id == id }) else { return false }
            return g.activeScans.contains { library.originalURL(tray, scan: $0).map { !FileManager.default.fileExists(atPath: $0.path) } ?? true }
        }
        todo.removeAll { lost.contains($0) }   // nothing to render them from: keep what Immich has

        progress(JobProgress("Connecting to Immich", total: todo.count * 2))
        let version = try await client.version()
        let albumName = tray.album.isEmpty ? tray.name : tray.album
        let album = try await client.findOrCreateAlbum(albumName)
        tray = try await library.update(trayID) { $0.immichAlbumId = album }

        var toTrash: [String] = []
        var result = Result(album: albumName)
        for (n, id) in todo.enumerated() {
            try Task.checkCancellation()
            progress(JobProgress("Rendering slide \(n + 1) of \(todo.count)", done: n * 2, total: todo.count * 2))
            tray = try await library.load(trayID)
            guard let index = tray.index(of: id) else { continue }   // merged away meanwhile
            let g = tray.groups[index]
            if g.skip || (onlyReady && !g.reviewed) { continue }
            let estimated = SlideDates.estimate(tray)
            let rkey = g.renderKey
            let meta = Tray.metaKey(g, date: estimated[index])
            let jpeg = try autoreleasepool { try render(tray, index: index, estimated: estimated) }
            progress(JobProgress("Uploading slide \(n + 1) of \(todo.count)", done: n * 2 + 1, total: todo.count * 2))
            let scan = g.activeScans[0]
            let filename = "\(slug(tray.name))_\(scan).jpg"
            let (assetID, _) = try await client.upload(jpeg: jpeg, filename: filename,
                                                       taken: Uploader.photoDate(tray, index: index, estimated: estimated),
                                                       deviceAssetID: "\(trayID)-\(id)-\(rkey.prefix(8))", major: version.major)
            try await client.addToAlbum(album, assets: [assetID])
            try await library.update(trayID) { fresh in
                guard let i = fresh.index(of: id) else { return }
                if let old = fresh.groups[i].immich?.assetId, old != assetID { toTrash.append(old) }
                fresh.groups[i].immich = UploadRecord(assetId: assetID, key: rkey, meta: meta)
            }
            result.uploaded += 1
        }
        try await library.update(trayID) { fresh in
            // slides merged away or skipped after uploading: their old Immich copies go to the trash
            toTrash += fresh.orphanAssets ?? []
            fresh.orphanAssets = nil
            for i in fresh.groups.indices where fresh.groups[i].skip && fresh.groups[i].immich != nil {
                toTrash.append(fresh.groups[i].immich!.assetId)
                fresh.groups[i].immich = nil
            }
            if !onlyReady || fresh.groups.allSatisfy({ $0.reviewed || $0.skip }) { fresh.dateKey = fresh.date }
            fresh.appendLog("Uploaded \(result.uploaded) slides to album '\(fresh.album)'")
        }
        try await client.trash(toTrash)
        result.lost = lost.count
        progress(JobProgress("Done — \(result.uploaded) slides uploaded to '\(albumName)'", done: 1, total: 1))
        return result
    }
}

func slug(_ s: String) -> String {
    let parts = s.lowercased().split { !($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
    let out = parts.joined(separator: "-")
    return out.isEmpty ? "session" : out
}

#if !canImport(ObjectiveC)
func autoreleasepool<T>(invoking body: () throws -> T) rethrows -> T { try body() }
#endif
