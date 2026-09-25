import CryptoKit
import Foundation

/// Proxies, blended brackets and previews for a tray (Python: `make_proxies`, `fused_proxy`,
/// `preview`). Proxies (1600 px) and fused proxies are cached as JPEG in the tray's cache folder,
/// so slider changes only re-run the colour pipeline on a small image.
public final class Renderer: @unchecked Sendable {
    public static let proxyEdge = 1600
    public static let thumbEdge = 240

    public let library: Library
    private let lock = NSLock()
    private var fused: [String: RGBImage] = [:]
    private var order: [String] = []

    public init(library: Library) { self.library = library }

    // MARK: per scan

    public func proxyURL(_ trayID: String, _ scan: String) -> URL { library.cacheDir(trayID).appendingPathComponent("\(scan).proxy.jpg") }
    public func thumbURL(_ trayID: String, _ scan: String) -> URL { library.cacheDir(trayID).appendingPathComponent("\(scan).thumb.jpg") }
    func signatureURL(_ trayID: String, _ scan: String) -> URL { library.cacheDir(trayID).appendingPathComponent("\(scan).sig") }

    /// Proxy JPEG, thumbnail and signature for one scan; skips work already done.
    public func makeProxies(_ tray: Tray, scan: String) throws {
        let p = proxyURL(tray.id, scan)
        guard !FileManager.default.fileExists(atPath: p.path) else { return }
        guard let original = library.originalURL(tray, scan: scan) else { throw SlideKitError.notFound(scan) }
        let a = try ImageFile.load(original, maxEdge: Renderer.proxyEdge)
        try ImageFile.jpeg(a, quality: 0.92).write(to: p, options: .atomic)
        try ImageFile.jpeg(a.fitting(maxEdge: Renderer.thumbEdge), quality: 0.8).write(to: thumbURL(tray.id, scan), options: .atomic)
        let sig = Brackets.signature(a)
        try sig.withUnsafeBufferPointer { Data(buffer: $0) }.write(to: signatureURL(tray.id, scan), options: .atomic)
    }

    public func proxy(_ tray: Tray, scan: String) throws -> RGBImage {
        try makeProxies(tray, scan: scan)
        return try ImageFile.load(proxyURL(tray.id, scan))
    }

    public func signature(_ tray: Tray, scan: String) throws -> [Float] {
        try makeProxies(tray, scan: scan)
        let data = try Data(contentsOf: signatureURL(tray.id, scan))
        return data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
    }

    // MARK: per slide

    /// The blended (not yet rotated or developed) proxy of a slide's active scans.
    public func fusedProxy(_ tray: Tray, _ slide: Slide) throws -> RGBImage {
        let scans = slide.activeScans
        let key = tray.id + ":" + scans.joined(separator: ",")
        if let hit = lock.withLock({ fused[key] }) { return hit }
        let file = library.cacheDir(tray.id).appendingPathComponent("fused_\(shortHash(key)).jpg")
        let a: RGBImage
        if FileManager.default.fileExists(atPath: file.path) {
            a = try ImageFile.load(file)
        } else if scans.count == 1 {
            a = try proxy(tray, scan: scans[0])
        } else {
            a = Fusion.fuse(try scans.map { try proxy(tray, scan: $0) })
            try ImageFile.jpeg(a, quality: 0.95).write(to: file, options: .atomic)
        }
        lock.withLock {
            fused[key] = a
            order.removeAll { $0 == key }; order.append(key)
            while order.count > 24 { fused[order.removeFirst()] = nil }
        }
        return a
    }

    /// The developed slide at preview size (or the untouched "before" in the same frame).
    public func preview(_ tray: Tray, _ slide: Slide, maxEdge: Int = 1600, before: Bool = false, crop: Bool = true) throws -> RGBImage {
        var a = try fusedProxy(tray, slide)
        if maxEdge < max(a.width, a.height) { a = a.fitting(maxEdge: maxEdge) }
        a = a.oriented(slide.rotation, mirror: slide.mirror)
        if before { return Develop.beforeView(a, slide.params, crop: crop) }
        Develop.developInPlace(&a, slide.params, crop: crop)
        return a
    }

    public func previewJPEG(_ tray: Tray, _ slide: Slide, maxEdge: Int = 1600, before: Bool = false) throws -> Data {
        try ImageFile.jpeg(preview(tray, slide, maxEdge: maxEdge, before: before), quality: 0.85)
    }

    /// Histograms of what the tone curve works on.
    public func histogram(_ tray: Tray, _ slide: Slide) throws -> [String: [Int]] {
        let a = try fusedProxy(tray, slide).fitting(maxEdge: 900).oriented(slide.rotation, mirror: slide.mirror)
        return Develop.histogram(Develop.toneBase(a, slide.params))
    }
}
