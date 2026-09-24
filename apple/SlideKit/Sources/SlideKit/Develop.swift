import Foundation

/// The colour pipeline, ported function by function from `imaging.py` (same names, same maths).
/// Parity with the Python implementation is checked by the golden tests.
public enum Develop {
    // MARK: auto restore

    /// Per-channel levels + partial grey-world midtone balance, with a guard against yellow skies.
    public static func autoRestore(_ a: RGBImage, strength: Double) -> RGBImage {
        var out = a
        autoRestoreInPlace(&out, strength: strength)
        return out
    }

    public static func autoRestoreInPlace(_ a: inout RGBImage, strength: Double) {
        guard strength > 0 else { return }
        let h = a.height, w = a.width
        let m = Int(Double(min(h, w)) * 0.04)
        let step = max(1, Int((Double(h * w) / 250_000).squareRoot()))
        var samples: [[Float]] = [[], [], []]
        a.data.withUnsafeBufferPointer { p in
            for y in stride(from: m, to: h - m, by: step) {
                for x in stride(from: m, to: w - m, by: step) {
                    let i = (y * w + x) * 3
                    samples[0].append(p[i]); samples[1].append(p[i + 1]); samples[2].append(p[i + 2])
                }
            }
        }
        let sorted = samples.map { $0.sorted() }
        let k = Float(min(1, strength * 2.5))   // levels reach full stretch from strength 0.4 upward
        var L = [Float](repeating: 0, count: 3), H = L, g = L
        for c in 0..<3 {
            L[c] = percentile(sorted: sorted[c], 0.4) * k
            H[c] = 1 - (1 - percentile(sorted: sorted[c], 99.6)) * k
        }
        // the median of the stretched samples is the stretched median (the stretch is monotonic)
        var med = [Double](repeating: 0, count: 3)
        for c in 0..<3 {
            let raw = percentile(sorted: sorted[c], 50)
            med[c] = Double(min(1, max(1e-4, (raw - L[c]) / max(H[c] - L[c], 1e-3))))
        }
        let tgt = exp(med.map(log).reduce(0, +) / 3)
        for c in 0..<3 {
            let lm = log(med[c])
            g[c] = lm == 0 ? 1 : Float(1 + (log(tgt) / lm - 1) * strength)
        }
        let hb = percentile(sorted: sorted[2], 99.6)
        // the sky guard's mask comes from the untouched blue channel, so build it first
        var mask = Plane(width: w, height: h)
        a.data.withUnsafeMutableBufferPointer { px in
            mask.data.withUnsafeMutableBufferPointer { mk in
                let px = px, mk = mk
                parallelFor(h) { rows in
                    for i in (rows.lowerBound * w)..<(rows.upperBound * w) {
                        mk[i] = min(1, max(0, (px[i * 3 + 2] - (hb - 0.10)) / 0.08))
                        for c in 0..<3 {
                            let v = min(1, max(0, (px[i * 3 + c] - L[c]) / max(H[c] - L[c], 1e-3)))
                            px[i * 3 + c] = g[c] == 1 ? v : powf(v, g[c])
                        }
                    }
                }
            }
        }
        mask = Filters.gaussianBlur(mask, sigma: 3)
        let s = Float(strength)
        a.data.withUnsafeMutableBufferPointer { o in
            mask.data.withUnsafeBufferPointer { mk in
                let o = o
                parallelFor(h) { rows in
                    for i in (rows.lowerBound * w)..<(rows.upperBound * w) {
                        let mv = mk[i] * s
                        let b = o[i * 3 + 2]
                        o[i * 3 + 2] = max(b, b * (1 - mv) + max(o[i * 3], o[i * 3 + 1]) * mv * 0.98)
                    }
                }
            }
        }
    }

    // MARK: trim

    /// (top, bottom, left, right) bounds that `trimBorders` keeps: dark mount edges cut away.
    public static func trimBounds(_ a: RGBImage, maxFrac: Double = 0.05) -> (Int, Int, Int, Int) {
        let w = a.width, h = a.height, bins = 65_536
        var rows = [Float](repeating: 0, count: h)
        // per-chunk column sums and luminance histograms, merged after (no full-size copy)
        let lock = NSLock()
        var cols = [Double](repeating: 0, count: w)
        var hist = [Int](repeating: 0, count: bins)
        a.data.withUnsafeBufferPointer { p in
            rows.withUnsafeMutableBufferPointer { rw in
                let rw = rw
                parallelFor(h) { range in
                    var c = [Double](repeating: 0, count: w)
                    var hs = [Int](repeating: 0, count: bins)
                    for y in range {
                        var rs: Float = 0
                        for x in 0..<w {
                            let i = (y * w + x) * 3
                            let v = (p[i] + p[i + 1] + p[i + 2]) / 3
                            rs += v; c[x] += Double(v)
                            hs[max(0, min(bins - 1, Int(v * Float(bins - 1) + 0.5)))] += 1
                        }
                        rw[y] = rs / Float(w)
                    }
                    lock.lock(); for x in 0..<w { cols[x] += c[x] }; for i in 0..<bins where hs[i] != 0 { hist[i] += hs[i] }; lock.unlock()
                }
            }
        }
        let colMeans = cols.map { Float($0 / Double(h)) }
        var ref: Float = 0.5, acc = 0
        let half = (w * h + 1) / 2
        for (i, n) in hist.enumerated() { acc += n; if acc >= half { ref = Float(i) / Float(bins - 1); break } }
        let thr = min(0.12, ref * 0.35)
        func cut(_ profile: [Float], _ limit: Int) -> Int {
            var n = 0
            while n < limit && profile[n] < thr { n += 1 }
            return n + (n > 0 ? 2 : 0)
        }
        let t = cut(rows, Int(Double(h) * maxFrac)), b = cut(rows.reversed(), Int(Double(h) * maxFrac))
        let l = cut(colMeans, Int(Double(w) * maxFrac)), r = cut(colMeans.reversed(), Int(Double(w) * maxFrac))
        return (t, h - b, l, w - r)
    }

    public static func trimBorders(_ a: RGBImage) -> RGBImage {
        let (t, b, l, r) = trimBounds(a)
        return a.cropped(top: t, bottom: b, left: l, right: r)
    }

    // MARK: geometry

    /// Rotate by a small angle about the centre, zoomed just enough that no empty corner shows.
    public static func straighten(_ a: RGBImage, angle: Double) -> RGBImage {
        guard abs(angle) >= 0.01 else { return a }
        let w = a.width, h = a.height
        let th = abs(angle) * .pi / 180
        let scale = cos(th) + sin(th) * Double(max(w, h)) / Double(min(w, h))
        let rad = angle * .pi / 180   // clockwise on screen (y down)
        let cs = Float(cos(rad) / scale), sn = Float(sin(rad) / scale)
        let cx = Float(w) / 2, cy = Float(h) / 2
        var out = RGBImage(width: w, height: h)
        a.data.withUnsafeBufferPointer { src in
            out.data.withUnsafeMutableBufferPointer { dst in
                for y in 0..<h {
                    for x in 0..<w {
                        let dx = Float(x) - cx, dy = Float(y) - cy
                        // inverse of a clockwise rotation: rotate the output point back counter-clockwise
                        let sx = cx + cs * dx + sn * dy, sy = cy - sn * dx + cs * dy
                        let x0 = Int(floor(sx)), y0 = Int(floor(sy))
                        let fx = sx - Float(x0), fy = sy - Float(y0)
                        let xa = reflect(x0, w), xb = reflect(x0 + 1, w), ya = reflect(y0, h), yb = reflect(y0 + 1, h)
                        let d = (y * w + x) * 3
                        for c in 0..<3 {
                            let p00 = src[(ya * w + xa) * 3 + c], p01 = src[(ya * w + xb) * 3 + c]
                            let p10 = src[(yb * w + xa) * 3 + c], p11 = src[(yb * w + xb) * 3 + c]
                            dst[d + c] = (p00 * (1 - fx) + p01 * fx) * (1 - fy) + (p10 * (1 - fx) + p11 * fx) * fy
                        }
                    }
                }
            }
        }
        return out
    }

    @inline(__always) static func reflect(_ i: Int, _ n: Int) -> Int {  // BORDER_REFLECT: fedcba|abcdef
        var i = i
        while i < 0 || i >= n { i = i < 0 ? -i - 1 : 2 * n - i - 1 }
        return i
    }

    public static func geometry(_ a: RGBImage, _ p: Params, crop: Bool = true) -> RGBImage {
        var out = a
        geometryInPlace(&out, p, crop: crop)
        return out
    }

    /// Rows `top..<bottom` and columns `left..<right` of a straightened `h` x `w` frame that `crop` keeps.
    public static func cropBox(_ h: Int, _ w: Int, _ c: [Double]) -> (top: Int, bottom: Int, left: Int, right: Int) {
        let t = Int(c[1] * Double(h)), l = Int(c[0] * Double(w))
        return (t, max(t + 1, Int(c[3] * Double(h))), l, max(l + 1, Int(c[2] * Double(w))))
    }

    public static func geometryInPlace(_ a: inout RGBImage, _ p: Params, crop: Bool = true) {
        if abs(p.angle) >= 0.01 { a = straighten(a, angle: p.angle) }
        if crop, let c = p.crop {
            let b = cropBox(a.height, a.width, c)
            a.cropInPlace(top: b.top, bottom: b.bottom, left: b.left, right: b.right)
        }
    }

    /// The image the tone curve works on: auto-restored, trimmed, repaired (dust, mould, Newton rings), straightened and cropped.
    public static func toneBase(_ a: RGBImage, _ p: Params, crop: Bool = true) -> RGBImage {
        var out = a
        toneBaseInPlace(&out, p, crop: crop)
        return out
    }

    public static func toneBaseInPlace(_ a: inout RGBImage, _ p: Params, crop: Bool = true) {
        autoRestoreInPlace(&a, strength: p.strength)
        if p.trim { let (t, b, l, r) = trimBounds(a); a.cropInPlace(top: t, bottom: b, left: l, right: r) }
        // after the trim, so the mount's edge is never taken for a scratch
        if p.dust > 0 { repairDustInPlace(&a, amount: p.dust) }
        if p.mould > 0 { repairMouldInPlace(&a, amount: p.mould) }   // after the dust
        if p.newton > 0 { repairNewtonInPlace(&a, amount: p.newton) }
        geometryInPlace(&a, p, crop: crop)
    }

    // MARK: develop

    /// crop = false: everything but the crop, for the crop tool to draw its frame over.
    public static func develop(_ a: RGBImage, _ p: Params, crop: Bool = true) -> RGBImage {
        var out = a
        developInPlace(&out, p, crop: crop)
        return out
    }

    /// The whole develop without a second full-size buffer (except when straightening).
    public static func developInPlace(_ a: inout RGBImage, _ p: Params, crop: Bool = true) {
        toneBaseInPlace(&a, p, crop: false)
        // the picture's frame, which local masks are drawn in (straighten keeps the size)
        let frame = (w: a.width, h: a.height)
        var at = (x: 0, y: 0)
        if crop, let c = p.crop {
            let b = cropBox(a.height, a.width, c)
            a.cropInPlace(top: b.top, bottom: b.bottom, left: b.left, right: b.right)
            at = (b.left, b.top)
        }
        Curves.applyInPlace(&a, p.curves)
        finish(&a, p)
        if !p.local.isEmpty { applyLocal(&a, p.local, frame: frame, at: at, angle: p.angle) }
    }

    /// Everything after the tone curves: white balance, brightness, contrast, saturation.
    static func finish(_ out: inout RGBImage, _ p: Params) {
        let eps: Float = 1e-5
        let gam: [Float] = [Float(1 - 0.25 * p.warmth), Float(1 + 0.25 * p.tint), Float(1 + 0.25 * p.warmth)]
        let wb = p.warmth != 0 || p.tint != 0
        let bright = Float(pow(2.0, -p.brightness))
        let con = Float(p.contrast), sat = Float(1.1 + p.saturation)
        let n = out.data.count / 3
        out.data.withUnsafeMutableBufferPointer { o in
          let o = o
          parallelFor(n, minChunk: 4096) { range in
            for i in range {
                var r = o[i * 3], g = o[i * 3 + 1], b = o[i * 3 + 2]
                if wb {
                    r = powf(min(1, max(eps, r)), gam[0]); g = powf(min(1, max(eps, g)), gam[1]); b = powf(min(1, max(eps, b)), gam[2])
                }
                if p.brightness != 0 {
                    r = powf(min(1, max(eps, r)), bright); g = powf(min(1, max(eps, g)), bright); b = powf(min(1, max(eps, b)), bright)
                }
                if con > 0 {
                    r += (r * r * (3 - 2 * r) - r) * con * 1.5
                    g += (g * g * (3 - 2 * g) - g) * con * 1.5
                    b += (b * b * (3 - 2 * b) - b) * con * 1.5
                } else if con < 0 {
                    r += (0.5 - r) * -con * 0.5; g += (0.5 - g) * -con * 0.5; b += (0.5 - b) * -con * 0.5
                }
                let lum = r * 0.299 + g * 0.587 + b * 0.114
                o[i * 3] = min(1, max(0, lum + (r - lum) * sat))
                o[i * 3 + 1] = min(1, max(0, lum + (g - lum) * sat))
                o[i * 3 + 2] = min(1, max(0, lum + (b - lum) * sat))
            }
          }
        }
    }

    /// The untouched scan in the developed photo's exact frame, for before/after that line up.
    public static func beforeView(_ a: RGBImage, _ p: Params, crop: Bool = true) -> RGBImage {
        var out = a
        if p.trim {
            let (t, b, l, r) = trimBounds(autoRestore(a, strength: p.strength))
            out = a.cropped(top: t, bottom: b, left: l, right: r)
        }
        return geometry(out, p, crop: crop)
    }

    // MARK: analysis

    static func inner(_ a: RGBImage, frac: Double = 0.03) -> RGBImage {
        let m = Int(Double(min(a.width, a.height)) * frac)
        return m == 0 ? a : a.cropped(top: m, bottom: a.height - m, left: m, right: a.width - m)
    }

    public static let histogramBins = 128

    /// Per-channel histograms of the curve's input (away from the edges).
    public static func histogram(_ a: RGBImage) -> [String: [Int]] {
        let s0 = inner(a)
        let s = s0.resized(width: 360, height: max(1, Int(360 * Double(a.height) / Double(a.width))))
        var out: [String: [Int]] = ["r": [], "g": [], "b": [], "lum": []]
        var bins = [[Int]](repeating: [Int](repeating: 0, count: histogramBins), count: 4)
        func bin(_ v: Float) -> Int { max(0, min(histogramBins - 1, Int(v * Float(histogramBins)))) }
        for i in 0..<s.pixelCount {
            let r = s.data[i * 3], g = s.data[i * 3 + 1], b = s.data[i * 3 + 2]
            bins[0][bin(r)] += 1; bins[1][bin(g)] += 1; bins[2][bin(b)] += 1
            bins[3][bin(r * 0.299 + g * 0.587 + b * 0.114)] += 1
        }
        out["r"] = bins[0]; out["g"] = bins[1]; out["b"] = bins[2]; out["lum"] = bins[3]
        return out
    }

    /// Pull each colour channel's end points in to where its data starts and ends (Python: fit_curves).
    public static func fitCurves(_ a: RGBImage, _ curves: [String: [[Double]]], clip: Double = 0.1) -> [String: [[Double]]] {
        let s = inner(a)
        let step = max(1, Int((Double(s.width * s.height) / 250_000).squareRoot()))
        var ch: [[Float]] = [[], [], []]
        for y in stride(from: 0, to: s.height, by: step) {
            for x in stride(from: 0, to: s.width, by: step) {
                let i = (y * s.width + x) * 3
                ch[0].append(s.data[i]); ch[1].append(s.data[i + 1]); ch[2].append(s.data[i + 2])
            }
        }
        var out = curves
        for (k, c) in ["r", "g", "b"].enumerated() {
            let sorted = ch[k].sorted()
            let l = Double(percentile(sorted: sorted, clip)), h = Double(percentile(sorted: sorted, 100 - clip))
            if h - l < 0.05 { continue }
            let old = curves[c] ?? [[0, 0], [1, 1]]
            let mid = old.dropFirst().dropLast().filter { l < $0[0] && $0[0] < h }
            out[c] = [[l, old[0][1]]] + mid + [[h, old[old.count - 1][1]]]
        }
        return Curves.clean(out)
    }

    /// Warmth and tint that make the spot at (x, y) (0..1 of the developed frame) neutral grey.
    public static func neutralBalance(_ a: RGBImage, _ p: Params, x: Double, y: Double) -> (warmth: Double, tint: Double) {
        let base = Curves.apply(toneBase(a, p), p.curves)
        let h = base.height, w = base.width
        let r = max(2, Int(Double(min(h, w)) * 0.006))
        let cx = Int(min(max(x, 0), 1) * Double(w - 1)), cy = Int(min(max(y, 0), 1) * Double(h - 1))
        var sum = [Double](repeating: 0, count: 3), n = 0.0
        for yy in max(0, cy - r)..<min(h, cy + r + 1) {
            for xx in max(0, cx - r)..<min(w, cx + r + 1) {
                for c in 0..<3 { sum[c] += Double(base.data[(yy * w + xx) * 3 + c]) }
                n += 1
            }
        }
        let lr = log(min(0.98, max(0.02, sum[0] / n))), lg = log(min(0.98, max(0.02, sum[1] / n))), lb = log(min(0.98, max(0.02, sum[2] / n)))
        let warmth = min(1, max(-1, 4 * (lr - lb) / (lr + lb)))
        let level = lr * (1 - 0.25 * warmth)
        let tint = min(1, max(-1, 4 * (level / lg - 1)))
        return ((warmth * 1000).rounded() / 1000, (tint * 1000).rounded() / 1000)
    }
}

/// Tone curves: a monotone cubic (Fritsch–Carlson) through the points, flat beyond the ends.
/// The same spline as `imaging.curve_lut` and `frontend/src/lib/curves.ts` — keep all three identical.
public enum Curves {
    public static let channels = ["rgb", "r", "g", "b"]
    public static let lutSize = 1024

    public static func clean(_ d: [String: [[Double]]]) -> [String: [[Double]]] {
        var out: [String: [[Double]]] = [:]
        for ch in channels {
            guard let pts = d[ch] else { continue }
            var clean: [[Double]] = []
            let valid: [(Double, Double)] = pts.prefix(16).compactMap { p -> (Double, Double)? in
                guard p.count >= 2 else { return nil }
                return (min(1.0, max(0.0, p[0])), min(1.0, max(0.0, p[1])))
            }
            let sorted = valid.sorted { a, b in a.0 != b.0 ? a.0 < b.0 : a.1 < b.1 }
            for pt in sorted {
                if let last = clean.last, pt.0 - last[0] < 0.004 { continue }
                clean.append([(pt.0 * 10_000).rounded() / 10_000, (pt.1 * 10_000).rounded() / 10_000])
            }
            if clean.count >= 2 && clean != [[0, 0], [1, 1]] { out[ch] = clean }
        }
        return out
    }

    public static func lut(_ pts: [[Double]], n: Int = lutSize) -> [Float] {
        let xs = pts.map { $0[0] }, ys = pts.map { $0[1] }
        let t = (0..<n).map { Double($0) / Double(n - 1) }
        if xs.count == 2 {
            return t.map { x in
                let v = x <= xs[0] ? ys[0] : x >= xs[1] ? ys[1] : ys[0] + (ys[1] - ys[0]) * (x - xs[0]) / (xs[1] - xs[0])
                return Float(min(1, max(0, v)))
            }
        }
        let k = xs.count
        let h = (0..<(k - 1)).map { xs[$0 + 1] - xs[$0] }
        let d = (0..<(k - 1)).map { (ys[$0 + 1] - ys[$0]) / h[$0] }
        var m = [Double](repeating: 0, count: k)
        m[0] = d[0]; m[k - 1] = d[k - 2]
        for i in 1..<(k - 1) { m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2 }
        for i in 0..<(k - 1) {
            if d[i] == 0 { m[i] = 0; m[i + 1] = 0; continue }
            let a = m[i] / d[i], b = m[i + 1] / d[i], r = a * a + b * b
            if r > 9 { let s = 3 / r.squareRoot(); m[i] = s * a * d[i]; m[i + 1] = s * b * d[i] }
        }
        return t.map { x in
            if x <= xs[0] { return Float(min(1, max(0, ys[0]))) }
            if x >= xs[k - 1] { return Float(min(1, max(0, ys[k - 1]))) }
            var i = 0
            while i < k - 2 && xs[i + 1] <= x { i += 1 }
            let u = min(1, max(0, (x - xs[i]) / h[i]))
            let h00 = 2 * u * u * u - 3 * u * u + 1, h10 = u * u * u - 2 * u * u + u
            let h01 = -2 * u * u * u + 3 * u * u, h11 = u * u * u - u * u
            let y = h00 * ys[i] + h10 * h[i] * m[i] + h01 * ys[i + 1] + h11 * h[i] * m[i + 1]
            return Float(min(1, max(0, y)))
        }
    }

    /// Per-colour curves first (they fix the cast), then the RGB curve on all three.
    public static func apply(_ a: RGBImage, _ curves: [String: [[Double]]]) -> RGBImage {
        var out = a
        applyInPlace(&out, curves)
        return out
    }

    public static func applyInPlace(_ a: inout RGBImage, _ curves: [String: [[Double]]]) {
        guard !curves.isEmpty else { return }
        let top = Float(lutSize - 1)
        let per = ["r", "g", "b"].map { curves[$0].map { lut($0) } }
        let all = curves["rgb"].map { lut($0) }
        let n = a.data.count / 3
        a.data.withUnsafeMutableBufferPointer { o in
            let o = o
            parallelFor(n, minChunk: 4096) { range in
                for i in range {
                    for c in 0..<3 {
                        var v = o[i * 3 + c]
                        if let l = per[c] { v = l[Int(min(top, max(0, v * top + 0.5)))] }
                        if let l = all { v = l[Int(min(top, max(0, v * top + 0.5)))] }
                        o[i * 3 + c] = v
                    }
                }
            }
        }
    }
}
