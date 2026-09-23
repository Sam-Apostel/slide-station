import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Interleaved RGB, Float 0...1 — the Swift counterpart of the float32 numpy arrays in `imaging.py`.
public struct RGBImage: Sendable {
    public var width: Int
    public var height: Int
    public var data: [Float]

    public init(width: Int, height: Int, data: [Float]) {
        precondition(data.count == width * height * 3)
        self.width = width; self.height = height; self.data = data
    }
    public init(width: Int, height: Int, fill: Float = 0) {
        self.init(width: width, height: height, data: [Float](repeating: fill, count: width * height * 3))
    }

    public var pixelCount: Int { width * height }

    /// Rows `top..<bottom`, columns `left..<right`.
    public func cropped(top: Int, bottom: Int, left: Int, right: Int) -> RGBImage {
        let t = max(0, min(height - 1, top)), b = max(t + 1, min(height, bottom))
        let l = max(0, min(width - 1, left)), r = max(l + 1, min(width, right))
        var out = RGBImage(width: r - l, height: b - t)
        data.withUnsafeBufferPointer { src in
            out.data.withUnsafeMutableBufferPointer { dst in
                for y in t..<b {
                    let s = (y * width + l) * 3, d = (y - t) * (r - l) * 3
                    for i in 0..<((r - l) * 3) { dst[d + i] = src[s + i] }
                }
            }
        }
        return out
    }

    /// Clockwise rotation by 0/90/180/270 degrees.
    public func rotated(_ degrees: Int) -> RGBImage {
        let rot = ((degrees % 360) + 360) % 360
        if rot == 0 { return self }
        let (w, h) = (width, height)
        let ow = rot == 180 ? w : h, oh = rot == 180 ? h : w
        var out = RGBImage(width: ow, height: oh)
        data.withUnsafeBufferPointer { src in
            out.data.withUnsafeMutableBufferPointer { dst in
                for y in 0..<oh {
                    for x in 0..<ow {
                        let (sx, sy): (Int, Int)
                        switch rot {
                        case 90: (sx, sy) = (y, h - 1 - x)
                        case 180: (sx, sy) = (w - 1 - x, h - 1 - y)
                        default: (sx, sy) = (w - 1 - y, x)
                        }
                        let s = (sy * w + sx) * 3, d = (y * ow + x) * 3
                        dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2]
                    }
                }
            }
        }
        return out
    }

    /// Luma as OpenCV's RGB2GRAY computes it (0.299 R + 0.587 G + 0.114 B).
    public func gray() -> Plane {
        var out = Plane(width: width, height: height)
        data.withUnsafeBufferPointer { src in
            out.data.withUnsafeMutableBufferPointer { dst in
                for i in 0..<pixelCount { dst[i] = 0.299 * src[i * 3] + 0.587 * src[i * 3 + 1] + 0.114 * src[i * 3 + 2] }
            }
        }
        return out
    }

    public func channel(_ c: Int) -> Plane {
        var out = Plane(width: width, height: height)
        data.withUnsafeBufferPointer { src in
            out.data.withUnsafeMutableBufferPointer { dst in for i in 0..<pixelCount { dst[i] = src[i * 3 + c] } }
        }
        return out
    }

    /// Area-average downscale (OpenCV INTER_AREA for shrinking).
    public func resized(width ow: Int, height oh: Int) -> RGBImage {
        let planes = (0..<3).map { channel($0).resized(width: ow, height: oh) }
        var out = RGBImage(width: ow, height: oh)
        for i in 0..<(ow * oh) { for c in 0..<3 { out.data[i * 3 + c] = planes[c].data[i] } }
        return out
    }

    public func fitting(maxEdge: Int) -> RGBImage {
        let edge = max(width, height)
        guard edge > maxEdge else { return self }
        let s = Double(maxEdge) / Double(edge)
        return resized(width: max(1, Int((Double(width) * s).rounded())), height: max(1, Int((Double(height) * s).rounded())))
    }
}

/// A single-channel Float image.
public struct Plane: Sendable {
    public var width: Int
    public var height: Int
    public var data: [Float]
    public init(width: Int, height: Int, fill: Float = 0) {
        self.width = width; self.height = height; data = [Float](repeating: fill, count: width * height)
    }
    public subscript(x: Int, y: Int) -> Float {
        get { data[y * width + x] }
        set { data[y * width + x] = newValue }
    }

    /// Area-average resize: each output pixel is the mean of the source area it covers.
    public func resized(width ow: Int, height oh: Int) -> Plane {
        if ow == width && oh == height { return self }
        let cols = Plane.areaWeights(from: width, to: ow), rows = Plane.areaWeights(from: height, to: oh)
        var tmp = [Float](repeating: 0, count: ow * height)
        data.withUnsafeBufferPointer { src in
            for y in 0..<height {
                let row = y * width
                for (x, taps) in cols.enumerated() {
                    var acc: Float = 0
                    for (i, w) in taps { acc += src[row + i] * w }
                    tmp[y * ow + x] = acc
                }
            }
        }
        var out = Plane(width: ow, height: oh)
        for (y, taps) in rows.enumerated() {
            for x in 0..<ow {
                var acc: Float = 0
                for (i, w) in taps { acc += tmp[i * ow + x] * w }
                out.data[y * ow + x] = acc
            }
        }
        return out
    }

    static func areaWeights(from n: Int, to m: Int) -> [[(Int, Float)]] {
        let scale = Double(n) / Double(m)
        return (0..<m).map { j in
            if scale <= 1 { // enlarging: OpenCV's INTER_AREA coefficients (nearest with a one-pixel ramp)
                let sx = Int(floor(Double(j) * scale))
                var f = Double(j + 1) - Double(sx + 1) / scale
                f = f <= 0 ? 0 : f - floor(f)
                let i0 = min(n - 1, sx), i1 = min(n - 1, sx + 1)
                return i0 == i1 || f == 0 ? [(i0, Float(1))] : [(i0, Float(1 - f)), (i1, Float(f))]
            }
            let a = Double(j) * scale, b = a + scale
            var taps: [(Int, Float)] = []
            var i = Int(floor(a))
            while Double(i) < b && i < n {
                let cover = min(b, Double(i + 1)) - max(a, Double(i))
                if cover > 1e-9 { taps.append((i, Float(cover / scale))) }
                i += 1
            }
            return taps
        }
    }

    public var mean: Float { data.reduce(0, +) / Float(max(1, data.count)) }
    public var std: Float {
        let m = mean
        return (data.reduce(0) { $0 + ($1 - m) * ($1 - m) } / Float(max(1, data.count))).squareRoot()
    }
}

// MARK: - OpenCV-style filters (BORDER_REFLECT_101)

@inline(__always) func reflect101(_ i: Int, _ n: Int) -> Int {
    if n == 1 { return 0 }
    var i = i
    while i < 0 || i >= n { i = i < 0 ? -i : 2 * n - 2 - i }
    return i
}

enum Filters {
    /// The kernel OpenCV builds for GaussianBlur(ksize 0, sigma) on float images.
    static func gaussianKernel(sigma: Double) -> [Float] {
        let size = max(1, Int((sigma * 4 * 2 + 1).rounded())) | 1
        let half = size / 2
        var k = (0..<size).map { i -> Double in let x = Double(i - half); return exp(-x * x / (2 * sigma * sigma)) }
        let s = k.reduce(0, +); k = k.map { $0 / s }
        return k.map(Float.init)
    }

    static func separable(_ p: Plane, _ k: [Float]) -> Plane {
        let half = k.count / 2, w = p.width, h = p.height
        var tmp = [Float](repeating: 0, count: w * h)
        p.data.withUnsafeBufferPointer { src in
            tmp.withUnsafeMutableBufferPointer { dst in
                for y in 0..<h {
                    let row = y * w
                    for x in 0..<w {
                        var acc: Float = 0
                        if x >= half && x < w - half {
                            for (j, kv) in k.enumerated() { acc += src[row + x + j - half] * kv }
                        } else {
                            for (j, kv) in k.enumerated() { acc += src[row + reflect101(x + j - half, w)] * kv }
                        }
                        dst[row + x] = acc
                    }
                }
            }
        }
        var out = Plane(width: w, height: h)
        tmp.withUnsafeBufferPointer { src in
            out.data.withUnsafeMutableBufferPointer { dst in
                for y in 0..<h {
                    for x in 0..<w {
                        var acc: Float = 0
                        for (j, kv) in k.enumerated() { acc += src[reflect101(y + j - half, h) * w + x] * kv }
                        dst[y * w + x] = acc
                    }
                }
            }
        }
        return out
    }

    static func gaussianBlur(_ p: Plane, sigma: Double) -> Plane { separable(p, gaussianKernel(sigma: sigma)) }

    /// cv2.Laplacian with ksize=1: the 4-neighbour kernel.
    static func laplacian(_ p: Plane) -> Plane {
        let w = p.width, h = p.height
        var out = Plane(width: w, height: h)
        p.data.withUnsafeBufferPointer { s in
            out.data.withUnsafeMutableBufferPointer { d in
                for y in 0..<h {
                    let yu = reflect101(y - 1, h) * w, yd = reflect101(y + 1, h) * w, row = y * w
                    for x in 0..<w {
                        let xl = reflect101(x - 1, w), xr = reflect101(x + 1, w)
                        d[row + x] = s[yu + x] + s[yd + x] + s[row + xl] + s[row + xr] - 4 * s[row + x]
                    }
                }
            }
        }
        return out
    }
}

// MARK: - Percentiles (numpy's default linear interpolation)

func percentile(sorted v: [Float], _ q: Double) -> Float {
    guard !v.isEmpty else { return 0 }
    let pos = q / 100 * Double(v.count - 1)
    let lo = Int(floor(pos)), hi = min(v.count - 1, lo + 1)
    let f = Float(pos - Double(lo))
    return v[lo] + (v[hi] - v[lo]) * f
}

// MARK: - Loading and encoding

public enum ImageFile {
    /// Decode a JPEG (or any ImageIO format) to float RGB, optionally downscaled on decode — the
    /// fast path, like PIL's `draft()` in the Python app.
    public static func load(_ url: URL, maxEdge: Int? = nil) throws -> RGBImage {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { throw SlideKitError.unreadable(url.lastPathComponent) }
        let cg: CGImage?
        if let maxEdge {
            let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                         kCGImageSourceThumbnailMaxPixelSize: maxEdge,
                                         kCGImageSourceCreateThumbnailWithTransform: false,
                                         kCGImageSourceShouldCacheImmediately: true]
            cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
        } else {
            cg = CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
        }
        guard let cg else { throw SlideKitError.unreadable(url.lastPathComponent) }
        return rgb(from: cg)
    }

    public static func rgb(from cg: CGImage) -> RGBImage {
        let w = cg.width, h = cg.height
        var bytes = [UInt8](repeating: 0, count: w * h * 4)
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        bytes.withUnsafeMutableBytes { buf in
            let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: cs,
                                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        }
        var out = RGBImage(width: w, height: h)
        bytes.withUnsafeBufferPointer { src in
            out.data.withUnsafeMutableBufferPointer { dst in
                for i in 0..<(w * h) {
                    dst[i * 3] = Float(src[i * 4]) / 255
                    dst[i * 3 + 1] = Float(src[i * 4 + 1]) / 255
                    dst[i * 3 + 2] = Float(src[i * 4 + 2]) / 255
                }
            }
        }
        return out
    }

    public static func cgImage(_ img: RGBImage) -> CGImage {
        let w = img.width, h = img.height
        var bytes = [UInt8](repeating: 255, count: w * h * 4)
        img.data.withUnsafeBufferPointer { src in
            bytes.withUnsafeMutableBufferPointer { dst in
                for i in 0..<(w * h) {
                    for c in 0..<3 { dst[i * 4 + c] = UInt8(max(0, min(255, src[i * 3 + c] * 255 + 0.5))) }
                }
            }
        }
        let provider = CGDataProvider(data: Data(bytes) as CFData)!
        return CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4,
                       space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                       provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)!
    }

    /// JPEG bytes, with optional EXIF/TIFF properties (ImageIO dictionaries).
    public static func jpeg(_ img: RGBImage, quality: Double = 0.88, properties: [CFString: Any] = [:]) throws -> Data {
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { throw SlideKitError.encode }
        var props = properties
        props[kCGImageDestinationLossyCompressionQuality] = quality
        CGImageDestinationAddImage(dest, cgImage(img), props as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw SlideKitError.encode }
        return data as Data
    }

    public struct Info: Sendable { public var make = "", model = "", dateTime = "" }

    /// EXIF make/model/date without decoding pixels.
    public static func info(_ url: URL) -> Info {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] else { return Info() }
        let tiff = props[kCGImagePropertyTIFFDictionary] as? [CFString: Any] ?? [:]
        let exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any] ?? [:]
        return Info(make: ((tiff[kCGImagePropertyTIFFMake] as? String) ?? "").trimmingCharacters(in: .whitespaces),
                    model: ((tiff[kCGImagePropertyTIFFModel] as? String) ?? "").trimmingCharacters(in: .whitespaces),
                    dateTime: (tiff[kCGImagePropertyTIFFDateTime] as? String) ?? (exif[kCGImagePropertyExifDateTimeOriginal] as? String) ?? "")
    }
}

public enum SlideKitError: LocalizedError {
    case unreadable(String), encode, verifyFailed(String), notFound(String), immich(String), originalsMissing
    public var errorDescription: String? {
        switch self {
        case .unreadable(let f): return "Couldn't read \(f)."
        case .encode: return "Couldn't encode the JPEG."
        case .verifyFailed(let f): return "Copy of \(f) did not verify — card or storage problem?"
        case .notFound(let s): return "\(s) not found."
        case .immich(let s): return s
        case .originalsMissing: return "The original scans for this slide are gone."
        }
    }
}
