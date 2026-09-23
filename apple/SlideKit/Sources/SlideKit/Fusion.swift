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
        guard images.count > 1 else { return images.first ?? RGBImage(width: 1, height: 1) }
        let w = images.map(\.width).min()!, h = images.map(\.height).min()!
        let cropped = images.map { $0.width == w && $0.height == h ? $0 : $0.cropped(top: 0, bottom: h, left: 0, right: w) }
        let aligned = shouldAlign ? align(cropped) : cropped

        // pass 1: the sum of the weights, to normalise with
        var weightSum = Plane(width: w, height: h)
        for im in aligned {
            let wt = weights(im)
            for i in 0..<(w * h) { weightSum.data[i] += wt.data[i] }
        }
        let levels = Int(log(Double(min(w, h))) / log(2.0))
        var result: [RGBImage] = []
        // pass 2: each scan's Laplacian pyramid, weighted by its Gaussian weight pyramid
        for im in aligned {
            var wt = weights(im)
            for i in 0..<(w * h) { wt.data[i] /= weightSum.data[i] }
            let wPyr = Pyramid.gaussian(wt, levels: levels)
            var iPyr = Pyramid.gaussian(im, levels: levels)
            for l in 0..<levels { iPyr[l] = subtract(iPyr[l], Pyramid.up(iPyr[l + 1], width: iPyr[l].width, height: iPyr[l].height)) }
            for l in 0...levels {
                let lw = wPyr[l]
                var layer = iPyr[l]
                for i in 0..<layer.pixelCount { let v = lw.data[i]; layer.data[i * 3] *= v; layer.data[i * 3 + 1] *= v; layer.data[i * 3 + 2] *= v }
                if result.count <= l { result.append(layer) } else { result[l] = add(result[l], layer) }
            }
        }
        for l in stride(from: levels, to: 0, by: -1) {
            result[l - 1] = add(result[l - 1], Pyramid.up(result[l], width: result[l - 1].width, height: result[l - 1].height))
        }
        var out = result[0]
        for i in 0..<out.data.count { out.data[i] = min(1, max(0, out.data[i])) }
        return out
    }

    /// contrast × saturation + 1e-12, per pixel.
    static func weights(_ im: RGBImage) -> Plane {
        let contrast = Filters.laplacian(im.gray())
        var out = Plane(width: im.width, height: im.height)
        for i in 0..<im.pixelCount {
            let r = im.data[i * 3], g = im.data[i * 3 + 1], b = im.data[i * 3 + 2]
            let m = (r + g + b) / 3
            let sat = ((r - m) * (r - m) + (g - m) * (g - m) + (b - m) * (b - m)).squareRoot()
            out.data[i] = abs(contrast.data[i]) * sat + 1e-12
        }
        return out
    }

    static func subtract(_ a: RGBImage, _ b: RGBImage) -> RGBImage {
        var o = a
        for i in 0..<o.data.count { o.data[i] -= b.data[i] }
        return o
    }
    static func add(_ a: RGBImage, _ b: RGBImage) -> RGBImage {
        var o = a
        for i in 0..<o.data.count { o.data[i] += b.data[i] }
        return o
    }

    // MARK: alignment

    /// Shift every scan onto the first. The scanner holds the slide still, but a hand-bracketed stack
    /// can move by a few pixels between presses. Registration runs on small copies and is scaled up.
    static func align(_ images: [RGBImage]) -> [RGBImage] {
        guard images.count > 1 else { return images }
        let ref = images[0]
        let scale = Double(min(1, 1200.0 / Double(max(ref.width, ref.height))))
        let small = { (im: RGBImage) in ImageFile.cgImage(scale < 1 ? im.fitting(maxEdge: 1200) : im) }
        let refCG = small(ref)
        return [ref] + images.dropFirst().map { im in
            let request = VNTranslationalImageRegistrationRequest(targetedCGImage: small(im))
            try? VNImageRequestHandler(cgImage: refCG, options: [:]).perform([request])
            guard let t = request.results?.first?.alignmentTransform else { return im }
            let dx = Int((t.tx / scale).rounded()), dy = Int((-t.ty / scale).rounded())  // Vision's y points up
            guard dx != 0 || dy != 0, abs(dx) < im.width / 10, abs(dy) < im.height / 10 else { return im }
            return shifted(im, dx: dx, dy: dy)
        }
    }

    static func shifted(_ im: RGBImage, dx: Int, dy: Int) -> RGBImage {
        var out = RGBImage(width: im.width, height: im.height)
        for y in 0..<im.height {
            let sy = min(im.height - 1, max(0, y - dy))
            for x in 0..<im.width {
                let sx = min(im.width - 1, max(0, x - dx))
                for c in 0..<3 { out.data[(y * im.width + x) * 3 + c] = im.data[(sy * im.width + sx) * 3 + c] }
            }
        }
        return out
    }
}

/// OpenCV's pyrDown / pyrUp: the 5-tap [1 4 6 4 1] / 16 kernel, BORDER_REFLECT_101.
enum Pyramid {
    static let k: [Float] = [1, 4, 6, 4, 1].map { $0 / 16 }

    static func gaussian(_ p: Plane, levels: Int) -> [Plane] {
        var out = [p]
        for _ in 0..<levels { out.append(down(out.last!)) }
        return out
    }
    static func gaussian(_ im: RGBImage, levels: Int) -> [RGBImage] {
        var out = [im]
        for _ in 0..<levels { out.append(down(out.last!)) }
        return out
    }

    static func down(_ p: Plane) -> Plane {
        let blurred = Filters.separable(p, k)
        var out = Plane(width: (p.width + 1) / 2, height: (p.height + 1) / 2)
        for y in 0..<out.height { for x in 0..<out.width { out[x, y] = blurred[x * 2, y * 2] } }
        return out
    }
    static func down(_ im: RGBImage) -> RGBImage {
        let ch = (0..<3).map { down(im.channel($0)) }
        return merge(ch)
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
        for y in 0..<p.height {
            for (x, taps) in xs.enumerated() {
                var acc: Float = 0
                for (i, w) in taps { acc += p.data[y * p.width + i] * w }
                tmp[y * width + x] = acc
            }
        }
        var out = Plane(width: width, height: height)
        for (y, taps) in ys.enumerated() {
            for x in 0..<width {
                var acc: Float = 0
                for (i, w) in taps { acc += tmp[i * width + x] * w }
                out.data[y * width + x] = acc
            }
        }
        return out
    }
    static func up(_ im: RGBImage, width: Int, height: Int) -> RGBImage {
        merge((0..<3).map { up(im.channel($0), width: width, height: height) })
    }

    static func merge(_ ch: [Plane]) -> RGBImage {
        var out = RGBImage(width: ch[0].width, height: ch[0].height)
        for i in 0..<out.pixelCount { for c in 0..<3 { out.data[i * 3 + c] = ch[c].data[i] } }
        return out
    }
}
