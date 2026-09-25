import Foundation

/// The slide mount's inner edge found on a scan (Python: `imaging.detect_mount`, stored as
/// `g["mount"]`): how far the picture is turned in it and where the window's sides are.
public struct MountEdge: Codable, Equatable, Hashable, Sendable {
    /// Degrees clockwise the picture is turned; straighten by `-angle`.
    public var angle: Double
    public var confidence: Double
    /// Each side's middle `[l, t, r, b]` in 0...1 of the unturned scan; nil where it wasn't found.
    public var box: [Double?]
    /// The active scans it was found on (a slide whose scans changed needs a new look).
    public var scans: [String]?

    public init(angle: Double, confidence: Double, box: [Double?], scans: [String]? = nil) {
        self.angle = angle; self.confidence = confidence; self.box = box; self.scans = scans
    }

    public static let notFound = MountEdge(angle: 0, confidence: 0, box: [nil, nil, nil, nil])
}

extension Slide {
    /// The stored mount if it was found on the slide's current scans (Python: `server._mount_view`).
    public var currentMount: MountEdge? { mount?.scans == activeScans ? mount : nil }

    /// A new slide straightens to its mount by itself only when the mount is found with confidence
    /// and the slide isn't framed or developed yet (Python: `workflow.straighten_to_mount`).
    public var straightensToMount: Bool {
        guard let m = mount else { return false }
        return m.confidence >= Develop.mountAuto && abs(m.angle) >= 0.1 && !developed && params.angle == 0 && params.crop == nil
    }
}

// MARK: - Mount detection

extension Develop {
    public static let mountEdge = 800         // the mount is found on the scan shrunk to this (longer edge)
    static let mountBand = 0.2                // its inner edge is looked for this far in from each side
    public static let mountSuggest = 0.5      // confidence from which "Straighten to mount" is offered
    public static let mountAuto = 0.8         // ... and from which an import straightens by itself
    static let mountInset = 0.005             // a tighter trim cuts this much inside the mount's edge

    /// Area-average down so the longer edge is at most `edge`, rounding half up (Python: `shrink`).
    public static func shrink(_ a: RGBImage, _ edge: Int) -> RGBImage {
        let w = a.width, h = a.height
        guard max(w, h) > edge else { return a }
        let s = Double(edge) / Double(max(w, h))
        return a.resized(width: max(1, Int(Double(w) * s + 0.5)), height: max(1, Int(Double(h) * s + 0.5)))
    }

    /// Where a profile (`at(k)`: k samples in from the border) first rises through `thr` for good
    /// (three samples in a row), sub-pixel; NaN if it doesn't start on the mount or never leaves it.
    static func edgeCrossing(band: Int, thr: Double, _ at: (Int) -> Float) -> Double {
        if Double(at(0)) >= thr { return .nan }
        var i = 1
        while i + 2 < band {
            if Double(at(i)) >= thr && Double(at(i + 1)) >= thr && Double(at(i + 2)) >= thr {
                let lo = Double(at(i - 1)), hi = Double(at(i))
                return Double(i - 1) + (thr - lo) / max(hi - lo, 1e-6) + 0.5
            }
            i += 1
        }
        return .nan
    }

    /// numpy's median of doubles (the two middle values averaged).
    static func median(_ v: [Double]) -> Double {
        let s = v.sorted(), n = s.count
        guard n > 0 else { return 0 }
        return n % 2 == 1 ? s[n / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
    }

    /// v = a + b u through the points, refitted four times without the ones far off the line.
    static func robustLine(_ u0: [Double], _ v0: [Double]) -> (a: Double, b: Double, kept: Int)? {
        var u: [Double] = [], v: [Double] = []
        for (x, y) in zip(u0, v0) where y.isFinite { u.append(x); v.append(y) }
        var inl = [Bool](repeating: true, count: u.count)
        var a0 = 0.0, b = 0.0
        for _ in 0..<4 {
            var n = 0, su = 0.0, sv = 0.0
            for i in u.indices where inl[i] { n += 1; su += u[i]; sv += v[i] }
            if n < 10 { return nil }
            let um = su / Double(n), vm = sv / Double(n)
            var num = 0.0, den = 0.0
            for i in u.indices where inl[i] { num += (u[i] - um) * (v[i] - vm); den += (u[i] - um) * (u[i] - um) }
            b = num / max(den, 1e-9)
            a0 = vm - b * um
            let r = u.indices.map { abs(v[$0] - (a0 + b * u[$0])) }
            let tol = max(0.5, 3 * 1.4826 * median(u.indices.filter { inl[$0] }.map { r[$0] }))
            inl = r.map { $0 <= tol }
        }
        return (a0, b, inl.filter { $0 }.count)
    }

    static func roundTo(_ v: Double, _ digits: Int) -> Double {
        let f = pow(10.0, Double(digits))
        return (v * f).rounded() / f
    }

    /// The slide mount's inner edge (Python: `detect_mount`). Each column (row) in the middle 80 %
    /// of each side is followed in from the border to where it leaves the mount's darkness; a
    /// robust line through those points is that side. Confidence needs two sides that agree.
    public static func detectMount(_ a: RGBImage) -> MountEdge {
        let s = shrink(a, mountEdge)
        let w = s.width, h = s.height
        var lum = [Float](repeating: 0, count: w * h)
        for i in 0..<(w * h) { lum[i] = (s.data[i * 3] + s.data[i * 3 + 1] + s.data[i * 3 + 2]) / 3 }
        let m = max(1, Int(Double(min(h, w)) * 0.01))
        var ring: [Float] = [], centre: [Float] = []
        for y in 0..<h { for x in 0..<w where y < m || y >= h - m || x < m || x >= w - m { ring.append(lum[y * w + x]) } }
        for y in (h / 4)..<(h - h / 4) { for x in (w / 4)..<(w - w / 4) { centre.append(lum[y * w + x]) } }
        let mount = Double(percentile(sorted: ring.sorted(), 50)), ref = Double(percentile(sorted: centre.sorted(), 50))
        if mount > 0.25 || ref - mount < 0.08 { return .notFound }   // no dark frame around a brighter picture
        let thr = mount + min(0.1, max(0.03, 0.3 * (ref - mount)))
        let bh = max(4, Int(Double(h) * mountBand)), bw = max(4, Int(Double(w) * mountBand))
        let x0 = Int(Double(w) * 0.1), y0 = Int(Double(h) * 0.1)
        let ux = (x0..<(w - x0)).map { Double($0) + 0.5 }, uy = (y0..<(h - y0)).map { Double($0) + 0.5 }
        func L(_ x: Int, _ y: Int) -> Float { lum[y * w + x] }
        let sides: [(String, [Double], [Double])] = [
            ("top", ux, (0..<ux.count).map { j in edgeCrossing(band: bh, thr: thr) { L(x0 + j, $0) } }),
            ("bottom", ux, (0..<ux.count).map { j in Double(h) - edgeCrossing(band: bh, thr: thr) { L(x0 + j, h - 1 - $0) } }),
            ("left", uy, (0..<uy.count).map { j in edgeCrossing(band: bw, thr: thr) { L($0, y0 + j) } }),
            ("right", uy, (0..<uy.count).map { j in Double(w) - edgeCrossing(band: bw, thr: thr) { L(w - 1 - $0, y0 + j) } }),
        ]
        var found: [String: (a: Double, b: Double, kept: Int)] = [:]
        var total = 0
        for (name, u, v) in sides {
            total += u.count
            if let fit = robustLine(u, v), Double(fit.kept) >= max(20, 0.35 * Double(u.count)) { found[name] = fit }
        }
        guard found.count >= 2 else { return .notFound }
        func ang(_ k: String) -> Double { atan(found[k]!.b) * 180 / .pi * (k == "top" || k == "bottom" ? 1 : -1) }
        let kept = Double(found.values.map(\.kept).reduce(0, +))
        let angle = found.keys.map { ang($0) * Double(found[$0]!.kept) }.reduce(0, +) / kept
        let spread = found.keys.map { abs(ang($0) - angle) }.max() ?? 0
        var conf = max(0, 1 - spread / 0.5) * min(1, kept / Double(total) / 0.6) * (found.count >= 3 ? 1 : 0.8)
        if abs(angle) > 10 { conf = 0 }
        func mid(_ k: String, _ c: Double, _ size: Int) -> Double? { found[k].map { roundTo(($0.a + $0.b * c) / Double(size), 4) } }
        let box = [mid("left", Double(h) / 2, w), mid("top", Double(w) / 2, h), mid("right", Double(h) / 2, w), mid("bottom", Double(w) / 2, h)]
        return MountEdge(angle: roundTo(angle, 2), confidence: roundTo(conf, 2), box: box)
    }

    /// A mount box `[l, t, r, b]` of a scan mirrored left-right (Python: `mirror_box`).
    public static func mirrorBox(_ box: [Double?]) -> [Double?] {
        [box[2].map { roundTo(1 - $0, 4) }, box[1], box[0].map { roundTo(1 - $0, 4) }, box[3]]
    }

    /// A mount box `[l, t, r, b]` of a scan turned clockwise by `rotation` (Python: `rotate_box`).
    public static func rotateBox(_ box: [Double?], _ rotation: Int) -> [Double?] {
        var b = box
        for _ in 0..<(((rotation % 360) + 360) % 360 / 90) {
            b = [b[3].map { roundTo(1 - $0, 4) }, b[0], b[1].map { roundTo(1 - $0, 4) }, b[2]]
        }
        return b
    }

    /// The crop that trims to the mount's window once straightened by `p.angle` (Python:
    /// `mount_crop`). `a` is the turned scan the slide develops from, `box` its turned mount sides.
    public static func mountCrop(_ a: RGBImage, _ p: Params, box: [Double?]) -> [Double]? {
        let w = Double(a.width), h = Double(a.height)
        let (t0, b0, l0, r0) = p.trim ? trimBounds(autoRestore(a, strength: p.strength)) : (0, a.height, 0, a.width)
        let fw = Double(r0 - l0), fh = Double(b0 - t0)
        let th = abs(p.angle) >= 0.01 ? p.angle * .pi / 180 : 0   // straighten() leaves tiny angles alone
        let scale = cos(abs(th)) + sin(abs(th)) * max(fw, fh) / min(fw, fh)
        let cs = cos(th), sn = sin(th)
        func place(_ x: Double, _ y: Double) -> (Double, Double) {
            let dx = x - 0.5 - Double(l0) - fw / 2, dy = y - 0.5 - Double(t0) - fh / 2   // pixel-index coordinates
            return ((fw / 2 + scale * (cs * dx - sn * dy) + 0.5) / fw, (fh / 2 + scale * (sn * dx + cs * dy) + 0.5) / fh)
        }
        var out = [0.0, 0.0, 1.0, 1.0]
        if let l = box[0] { out[0] = place(l * w, h / 2).0 + mountInset }
        if let t = box[1] { out[1] = place(w / 2, t * h).1 + mountInset }
        if let r = box[2] { out[2] = place(r * w, h / 2).0 - mountInset }
        if let b = box[3] { out[3] = place(w / 2, b * h).1 - mountInset }
        return Params.cleanCrop(out)
    }
}

// MARK: - Dust & scratches

extension Develop {
    public static let dustEdge = 1600   // specks are found at proxy scale: full resolution is shrunk to this first
    static let dustPasses = 8

    /// Min (erode) or max (dilate) over the (2r + 1)² window clipped to the image: cv2.erode / dilate.
    static func morph(_ src: [Float], _ w: Int, _ h: Int, _ r: Int, max isMax: Bool) -> [Float] {
        var tmp = [Float](repeating: 0, count: w * h), out = tmp
        for y in 0..<h {
            for x in 0..<w {
                var v = src[y * w + x]
                for k in Swift.max(0, x - r)...Swift.min(w - 1, x + r) {
                    let s = src[y * w + k]
                    if isMax ? s > v : s < v { v = s }
                }
                tmp[y * w + x] = v
            }
        }
        for y in 0..<h {
            for x in 0..<w {
                var v = tmp[y * w + x]
                for k in Swift.max(0, y - r)...Swift.min(h - 1, y + r) {
                    let s = tmp[k * w + x]
                    if isMax ? s > v : s < v { v = s }
                }
                out[y * w + x] = v
            }
        }
        return out
    }

    /// Dust specks and thin scratches (Python: `dust_mask`): small marks a morphological opening /
    /// closing takes away, with more contrast than `amount` asks for, not part of texture (more
    /// than a fifth of the neighbourhood marked), grown by a pixel. Float arithmetic like numpy's.
    public static func dustMask(_ a: RGBImage, amount: Double) -> (mask: [UInt8], r: Int) {
        let w = a.width, h = a.height
        let c0: Float = 0.299, c1: Float = 0.587, c2: Float = 0.114
        var lum = [Float](repeating: 0, count: w * h)
        for i in 0..<(w * h) {
            let r = a.data[i * 3] * c0, g = a.data[i * 3 + 1] * c1, b = a.data[i * 3 + 2] * c2
            let rg = r + g
            lum[i] = rg + b
        }
        let r = max(1, Int(3 * Double(max(w, h)) / Double(dustEdge) + 0.5))
        let opened = morph(morph(lum, w, h, r, max: false), w, h, r, max: true)
        let closed = morph(morph(lum, w, h, r, max: true), w, h, r, max: false)
        let thr = Float(0.25 - 0.19 * amount)
        var m = [UInt8](repeating: 0, count: w * h)
        for i in 0..<(w * h) {
            let top = lum[i] - opened[i], bottom = closed[i] - lum[i]
            m[i] = max(top, bottom) > thr ? 1 : 0
        }
        // texture, not dust: more than a fifth of the (8r + 1)² neighbourhood responds
        var ii = [Int](repeating: 0, count: (w + 1) * (h + 1))
        for y in 0..<h {
            var row = 0
            for x in 0..<w { row += Int(m[y * w + x]); ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1] + row }
        }
        let rad = 4 * r
        var kept = [UInt8](repeating: 0, count: w * h)
        for y in 0..<h {
            let ya = max(0, y - rad), yb = min(h, y + rad + 1)
            for x in 0..<w where m[y * w + x] != 0 {
                let xa = max(0, x - rad), xb = min(w, x + rad + 1)
                let cnt = ii[yb * (w + 1) + xb] - ii[ya * (w + 1) + xb] - ii[yb * (w + 1) + xa] + ii[ya * (w + 1) + xa]
                if cnt * 5 <= (yb - ya) * (xb - xa) { kept[y * w + x] = 1 }
            }
        }
        var mask = [UInt8](repeating: 0, count: w * h)
        for y in 0..<h {
            for x in 0..<w {
                search: for yy in max(0, y - 1)...min(h - 1, y + 1) {
                    for xx in max(0, x - 1)...min(w - 1, x + 1) where kept[yy * w + xx] != 0 { mask[y * w + x] = 1; break search }
                }
            }
        }
        return (mask, r)
    }

    /// Median of the first n values, numpy's way (the two middle ones averaged, in Float).
    static func median(_ v: inout [Float], _ n: Int) -> Float {
        v[0..<n].sort()
        return n % 2 == 1 ? v[n / 2] : (v[n / 2 - 1] + v[n / 2]) / 2
    }

    public static func repairDust(_ a: RGBImage, amount: Double) -> RGBImage {
        var out = a
        repairDustInPlace(&out, amount: amount)
        return out
    }

    /// Find dust and scratches at proxy scale and fill each marked pixel with the per-channel median
    /// of the unmarked pixels around it, pass by pass (Python: `repair_dust`). At full resolution the
    /// window keeps the proxy's number of samples, spaced a proxy pixel apart.
    public static func repairDustInPlace(_ a: inout RGBImage, amount: Double) {
        guard amount > 0 else { return }
        let w = a.width, h = a.height
        let small = shrink(a, dustEdge)
        let (m0, r) = dustMask(small, amount: amount)
        guard m0.contains(1) else { return }
        let mw = small.width, mh = small.height
        var known = [UInt8](repeating: 1, count: w * h)
        if mw == w && mh == h {
            for i in 0..<(w * h) { known[i] = 1 - m0[i] }
        } else {   // full resolution: every pixel takes its proxy pixel's verdict
            let xs = (0..<w).map { min(Int((Double($0) + 0.5) * Double(mw) / Double(w)), mw - 1) }
            for y in 0..<h {
                let my = min(Int((Double(y) + 0.5) * Double(mh) / Double(h)), mh - 1) * mw
                for x in 0..<w { known[y * w + x] = 1 - m0[my + xs[x]] }
            }
        }
        let f = Double(max(h, w)) / Double(max(mh, mw))
        let off = (-(r + 1)...(r + 1)).map { ($0 >= 0 ? 1 : -1) * Int(Double(abs($0)) * f + 0.5) }
        let todo = (0..<(w * h)).filter { known[$0] == 0 }
        _ = medianFill(&a, known: &known, todo: todo, off: off, passes: dustPasses)
    }

    /// Fill pixels `todo` of `a` with the per-channel median of the known pixels among the samples
    /// at `off` × `off` around each (Python: `_median_fill`); pixels with none wait for the next
    /// pass, which can use the ones filled before it. Returns the pixels still unfilled.
    static func medianFill(_ a: inout RGBImage, known: inout [UInt8], todo start: [Int], off: [Int], passes: Int) -> [Int] {
        let w = a.width, h = a.height
        var todo = start
        var buf = [[Float]](repeating: [Float](repeating: 0, count: off.count * off.count), count: 3)
        for _ in 0..<passes where !todo.isEmpty {
            var vals = [Float](repeating: 0, count: todo.count * 3)
            var done = [Bool](repeating: false, count: todo.count)
            for (j, i) in todo.enumerated() {
                let y = i / w, x = i % w
                var n = 0
                for dy in off {
                    let yy = y + dy
                    guard yy >= 0 && yy < h else { continue }
                    for dx in off {
                        let xx = x + dx
                        guard xx >= 0 && xx < w && known[yy * w + xx] != 0 else { continue }
                        let s = (yy * w + xx) * 3
                        buf[0][n] = a.data[s]; buf[1][n] = a.data[s + 1]; buf[2][n] = a.data[s + 2]
                        n += 1
                    }
                }
                guard n > 0 else { continue }   // the middle of a larger mark: next pass
                for c in 0..<3 { vals[j * 3 + c] = median(&buf[c], n) }
                done[j] = true
            }
            // a pass reads only pixels known before it
            for (j, i) in todo.enumerated() where done[j] {
                for c in 0..<3 { a.data[i * 3 + c] = vals[j * 3 + c] }
                known[i] = 1
            }
            todo = todo.enumerated().filter { !done[$0.offset] }.map(\.element)
        }
        return todo
    }
}
