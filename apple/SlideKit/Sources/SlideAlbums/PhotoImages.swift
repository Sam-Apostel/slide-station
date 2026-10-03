import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Album images, decoded at the size they're shown. The bytes of thumbnails and previews are kept on
/// disk (in the App Group, so the widget finds what the app already fetched); full-size images only
/// in memory, they are big and the TV fetches them again cheaply on the LAN.
public actor PhotoImages {
    public static let shared = PhotoImages()

    private let memory = NSCache<NSString, CGImageBox>()
    private var running: [String: Task<CGImage, Error>] = [:]
    private let folder = SharedStore.folder.appendingPathComponent("Images", isDirectory: true)

    init() {
        memory.totalCostLimit = 192 << 20   // decoded bytes
    }

    final class CGImageBox { let image: CGImage; init(_ i: CGImage) { image = i } }

    /// Nil while nothing is cached for it yet (a view shows this instantly, then asks `image`).
    public func cached(_ id: String, size: AlbumClient.Size, maxPixel: Int) -> CGImage? {
        memory.object(forKey: Self.key(id, size, maxPixel) as NSString)?.image
    }

    /// The photo as an image no larger than `maxPixel` on its long side.
    public func image(_ id: String, size: AlbumClient.Size, maxPixel: Int, client: AlbumClient) async throws -> CGImage {
        let key = Self.key(id, size, maxPixel)
        if let hit = memory.object(forKey: key as NSString) { return hit.image }
        if let task = running[key] { return try await task.value }
        let file = diskURL(id, size)
        let task = Task.detached(priority: .userInitiated) { () throws -> CGImage in
            var data = file.flatMap { try? Data(contentsOf: $0) }
            if data == nil {
                let fetched = try await client.image(id, size: size)
                if let file {
                    try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try? fetched.write(to: file, options: .atomic)
                }
                data = fetched
            }
            guard let data, let img = Self.decode(data, maxPixel: maxPixel) else {
                throw AlbumError.server("Couldn't read the image Immich sent.")
            }
            return img
        }
        running[key] = task
        defer { running[key] = nil }
        let img = try await task.value
        memory.setObject(CGImageBox(img), forKey: key as NSString, cost: img.bytesPerRow * img.height)
        return img
    }

    /// The encoded bytes on disk, for the widget (which writes its own small copies).
    public func data(_ id: String, size: AlbumClient.Size, client: AlbumClient) async throws -> Data {
        if let file = diskURL(id, size), let d = try? Data(contentsOf: file) { return d }
        let d = try await client.image(id, size: size)
        if let file = diskURL(id, size) {
            try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? d.write(to: file, options: .atomic)
        }
        return d
    }

    private nonisolated func diskURL(_ id: String, _ size: AlbumClient.Size) -> URL? {
        size == .fullsize ? nil : folder.appendingPathComponent(size.rawValue, isDirectory: true).appendingPathComponent(id)
    }

    private static func key(_ id: String, _ size: AlbumClient.Size, _ px: Int) -> String { "\(id)|\(size.rawValue)|\(px)" }

    /// Decode at most `maxPixel` on the long side, turned by its EXIF orientation.
    public static func decode(_ data: Data, maxPixel: Int) -> CGImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(1, maxPixel),
        ]
        return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
    }

    /// JPEG bytes of an image (the widget's own small copies).
    public static func jpeg(_ image: CGImage, quality: Double = 0.85) -> Data? {
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        return CGImageDestinationFinalize(dest) ? out as Data : nil
    }

    /// Keep the disk cache under `limit` bytes, dropping what was used longest ago.
    public func trim(to limit: Int = 600 << 20) {
        let fm = FileManager.default
        let keys: [URLResourceKey] = [.contentAccessDateKey, .contentModificationDateKey, .fileSizeKey]
        guard let files = fm.enumerator(at: folder, includingPropertiesForKeys: keys)?.allObjects as? [URL] else { return }
        var entries = files.compactMap { u -> (URL, Date, Int)? in
            guard let v = try? u.resourceValues(forKeys: Set(keys)), let size = v.fileSize else { return nil }
            return (u, v.contentAccessDate ?? v.contentModificationDate ?? .distantPast, size)
        }
        var total = entries.reduce(0) { $0 + $1.2 }
        guard total > limit else { return }
        entries.sort { $0.1 < $1.1 }
        for (u, _, size) in entries where total > limit {
            try? fm.removeItem(at: u)
            total -= size
        }
    }
}
