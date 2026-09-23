import CoreGraphics
import Foundation
import Vision

/// Align and exposure-fuse several scans of one slide — Mertens et al., as OpenCV's MergeMertens
/// does it with its defaults (contrast and saturation weights 1, well-exposedness 0).
///
/// Memory: works one scan at a time against the result pyramid, so the peak is roughly the result
/// pyramid plus one scan's pyramid and weights (~1 GB for a 22 MP bracket in Float). The roadmap's
/// half-precision, tiled GPU version is the next step for older iPads.
public enum Fusion {
    public static func fuse(_ images: [RGBImage], align shouldAlign: Bool = true) -> RGBImage {
        fuse(sources: images, align: shouldAlign)
    }

    /// Mertens over any row sources, one colour channel at a time: the peak is one channel's
    /// pyramids (result, scan, weights) plus the output, never a whole RGB pyramid per scan. For a
    /// 20 MP bracket read from 8-bit scans that is well under 1 GB.
    public static func fuse(sources input: [any RowSource], align shouldAlign: Bool = true) -> RGBImage {
        guard input.count > 1 else { return input.first?.rgbImage() ?? RGBImage(width: 1, height: 1) }
        let w = input.map(\.width).min()!, h = input.map(\.height).min()!
        let cropped: [any RowSource] = input.map { $0.width == w && $0.height == h ? $0 : CroppedSource(base: $0, width: w, height: h) }
        let sources = shouldAlign ? align(cropped) : cropped

        var weightSum = Plane(width: w, height: h)
        for src in sources {
            let wt = weights(src)
            weightSum.data.withUnsafeMutableBufferPointer { s in
                wt.data.withUnsafeBufferPointer { v in let s = s; parallelFor(w * h, minChunk: 4096) { r in for i in r { s[i] += v[i] } } }
            }
        }
        let levels = Int(log(Double(min(w, h))) / log(2.0))
        var out = RGBImage(width: w, height: h)
        for c in 0..<3 {
            var result: [Plane] = []
            for src in sources {
                // the weights are cheap to recompute; keeping three weight pyramids is not
                var wt = weights(src)
                wt.data.withUnsafeMutableBufferPointer { v in
                    weightSum.data.withUnsafeBufferPointer { s in let v = v; parallelFor(w * h, minChunk: 4096) { r in for i in r { v[i] /= s[i] } } }
                }
                let wPyr = Pyramid.gaussian(wt, levels: levels)
                wt = Plane(width: 0, height: 0)
                var lap = Pyramid.gaussian(channel(src, c), levels: levels)
                for l in 0..<levels { subtract(&lap[l], Pyramid.up(lap[l + 1], width: lap[l].width, height: lap[l].height)) }
                for l in 0...levels {
                    multiply(&lap[l], wPyr[l])
                    if result.count <= l { result.append(lap[l]) } else { add(&result[l], lap[l]) }
                    lap[l] = Plane(width: 0, height: 0)
                }
            }
            for l in stride(from: levels, to: 0, by: -1) {
                add(&result[l - 1], Pyramid.up(result[l], width: result[l - 1].width, height: result[l - 1].height))
                result.removeLast()
            }
            let plane = result[0]
            out.data.withUnsafeMutableBufferPointer { o in
                plane.data.withUnsafeBufferPointer { p in
                    let o = o
                    parallelFor(w * h, minChunk: 4096) { r in for i in r { o[i * 3 + c] = min(1, max(0, p[i])) } }
                }
            }
        }
        return out
    }

    /// contrast × saturation + 1e-12, per pixel.
    static func weights(_ src: any RowSource) -> Plane {
        let w = src.width, h = src.height
        var gray = Plane(width: w, height: h), sat = Plane(width: w, height: h)
        gray.data.withUnsafeMutableBufferPointer { g in
            sat.data.withUnsafeMutableBufferPointer { s in
                let g = g, s = s
                src.forEachRow { y, row in
                    for x in 0..<w {
                        let r = row[x * 3], gg = row[x * 3 + 1], b = row[x * 3 + 2]
                        g[y * w + x] = 0.299 * r + 0.587 * gg + 0.114 * b
                        let m = (r + gg + b) / 3
                        s[y * w + x] = ((r - m) * (r - m) + (gg - m) * (gg - m) + (b - m) * (b - m)).squareRoot()
                    }
                }
            }
        }
        let contrast = Filters.laplacian(gray)
        gray = Plane(width: 0, height: 0)
        sat.data.withUnsafeMutableBufferPointer { s in
            contrast.data.withUnsafeBufferPointer { c in let s = s; parallelFor(w * h, minChunk: 4096) { r in for i in r { s[i] = abs(c[i]) * s[i] + 1e-12 } } }
        }
        return sat
    }

    static func channel(_ src: any RowSource, _ c: Int) -> Plane {
        let w = src.width
        var out = Plane(width: w, height: src.height)
        out.data.withUnsafeMutableBufferPointer { o in
            let o = o
            src.forEachRow { y, row in for x in 0..<w { o[y * w + x] = row[x * 3 + c] } }
        }
        return out
    }

    static func subtract(_ a: inout Plane, _ b: Plane) { combine(&a, b) { $0 - $1 } }
    static func add(_ a: inout Plane, _ b: Plane) { combine(&a, b) { $0 + $1 } }
    static func multiply(_ a: inout Plane, _ b: Plane) { combine(&a, b) { $0 * $1 } }
    @inline(__always) static func combine(_ a: inout Plane, _ b: Plane, _ f: (Float, Float) -> Float) {
        let n = a.data.count
        a.data.withUnsafeMutableBufferPointer { x in
            b.data.withUnsafeBufferPointer { y in let x = x; parallelFor(n, minChunk: 8192) { r in for i in r { x[i] = f(x[i], y[i]) } } }
        }
    }

    // MARK: alignment

    /// Shift every scan onto the first. The scanner holds the slide still, but a hand-bracketed stack
    /// can move by a few pixels between presses. Registration runs on small copies and is scaled up;
    /// the shift is applied while reading, not by copying the scan.
    static func align(_ sources: [any RowSource]) -> [any RowSource] {
        guard sources.count > 1 else { return sources }
        let ref = sources[0]
        let small = ref.thumbnail(maxEdge: 1200)
        let scale = Double(small.width) / Double(ref.width)
        let refCG = ImageFile.cgImage(small)
        return [ref] + sources.dropFirst().map { src -> any RowSource in
            let request = VNTranslationalImageRegistrationRequest(targetedCGImage: ImageFile.cgImage(src.thumbnail(maxEdge: 1200)))
            try? VNImageRequestHandler(cgImage: refCG, options: [:]).perform([request])
            guard let t = request.results?.first?.alignmentTransform else { return src }
            let dx = Int((t.tx / scale).rounded()), dy = Int((-t.ty / scale).rounded())  // Vision's y points up
            guard dx != 0 || dy != 0, abs(dx) < src.width / 10, abs(dy) < src.height / 10 else { return src }
            return ShiftedSource(base: src, dx: dx, dy: dy)
        }
    }

    static func shifted(_ im: RGBImage, dx: Int, dy: Int) -> RGBImage { ShiftedSource(base: im, dx: dx, dy: dy).rgbImage() }
}

/// OpenCV's pyrDown / pyrUp: the 5-tap [1 4 6 4 1] / 16 kernel, BORDER_REFLECT_101.
enum Pyramid {
    static let k: [Float] = [1, 4, 6, 4, 1].map { $0 / 16 }

    static func gaussian(_ p: Plane, levels: Int) -> [Plane] {
        var out = [p]
        for _ in 0..<levels { out.append(down(out.last!)) }
        return out
    }
    /// Blur with [1 4 6 4 1]/16 and keep every other pixel — computing only the kept samples.
    static func down(_ p: Plane) -> Plane {
        let w = p.width, h = p.height, ow = (w + 1) / 2, oh = (h + 1) / 2
        var tmp = [Float](repeating: 0, count: w * oh)   // vertical pass on the even rows
        p.data.withUnsafeBufferPointer { s in
            tmp.withUnsafeMutableBufferPointer { t in
                let t = t
                parallelFor(oh) { rows in
                    for oy in rows {
                        let y = oy * 2
                        let r = (-2...2).map { reflect101(y + $0, h) * w }
                        for x in 0..<w {
                            t[oy * w + x] = (s[r[0] + x] + s[r[4] + x]) * k[0] + (s[r[1] + x] + s[r[3] + x]) * k[1] + s[r[2] + x] * k[2]
                        }
                    }
                }
            }
        }
        var out = Plane(width: ow, height: oh)
        tmp.withUnsafeBufferPointer { t in
            out.data.withUnsafeMutableBufferPointer { o in
                let o = o
                parallelFor(oh) { rows in
                    for oy in rows {
                        let row = oy * w
                        for ox in 0..<ow {
                            let x = ox * 2
                            o[oy * ow + ox] = (t[row + reflect101(x - 2, w)] + t[row + reflect101(x + 2, w)]) * k[0]
                                + (t[row + reflect101(x - 1, w)] + t[row + reflect101(x + 1, w)]) * k[1] + t[row + x] * k[2]
                        }
                    }
                }
            }
        }
        return out
    }

    /// Upsample to (width, height) exactly as cv::pyrUp does: per axis, even outputs are
    /// (s[i-1] + 6 s[i] + s[i+1]) / 8 and odd ones (s[i] + s[i+1]) / 2, reflecting at the start
    /// (s[-1] = s[1]) but repeating at the end (s[n] = s[n-1]). The borders matter: coarse levels
    /// are only a few pixels wide and carry the picture's overall colour.
    static func up(_ p: Plane, width: Int, height: Int) -> Plane {
        func axis(_ n: Int, _ outN: Int) -> [[(Int, Float)]] {
            (0..<outN).map { d in
                let i = min(n - 1, d / 2)
                let prev = i == 0 ? min(1, n - 1) : i - 1, next = min(n - 1, i + 1)
                let even: [(Int, Float)] = [(prev, 0.125), (i, 0.75), (next, 0.125)], odd: [(Int, Float)] = [(i, 0.5), (next, 0.5)]
                return d % 2 == 0 ? even : odd
            }
        }
        let xs = axis(p.width, width), ys = axis(p.height, height)
        var tmp = [Float](repeating: 0, count: width * p.height)
        p.data.withUnsafeBufferPointer { s in
            tmp.withUnsafeMutableBufferPointer { t in
                let t = t
                parallelFor(p.height) { rows in
                    for y in rows {
                        for (x, taps) in xs.enumerated() {
                            var acc: Float = 0
                            for (i, w) in taps { acc += s[y * p.width + i] * w }
                            t[y * width + x] = acc
                        }
                    }
                }
            }
        }
        var out = Plane(width: width, height: height)
        tmp.withUnsafeBufferPointer { t in
            out.data.withUnsafeMutableBufferPointer { o in
                let o = o
                parallelFor(height) { rows in
                    for y in rows {
                        let taps = ys[y]
                        for x in 0..<width {
                            var acc: Float = 0
                            for (i, w) in taps { acc += t[i * width + x] * w }
                            o[y * width + x] = acc
                        }
                    }
                }
            }
        }
        return out
    }
}
