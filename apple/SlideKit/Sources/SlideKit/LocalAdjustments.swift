import Foundation

/// One brush stroke of a local adjustment: a polyline in 0...1 of the picture.
public struct BrushStroke: Codable, Equatable, Hashable, Sendable {
    public var points: [[Double]]
    public var radius: Double = 0.05      // fraction of the picture's longer edge
    public var hardness: Double = 0.5
    public var flow: Double = 1
    public var erase: Bool = false

    enum CodingKeys: String, CodingKey { case points, radius, hardness, flow, erase }

    public init(points: [[Double]], radius: Double = 0.05, hardness: Double = 0.5, flow: Double = 1, erase: Bool = false) {
        self.points = points; self.radius = radius; self.hardness = hardness; self.flow = flow; self.erase = erase
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        points = (try? c.decode([[Double]].self, forKey: .points)) ?? []
        radius = (try? c.decode(Double.self, forKey: .radius)) ?? 0.05
        hardness = (try? c.decode(Double.self, forKey: .hardness)) ?? 0.5
        flow = (try? c.decode(Double.self, forKey: .flow)) ?? 1
        erase = (try? c.decode(Bool.self, forKey: .erase)) ?? false
    }
}

/// A local adjustment (Python: one entry of `Params.local`, `imaging.clean_local`): a mask plus its
/// own sliders. Points are 0...1 of the picture — the trimmed, turned scan before straightening —
/// so a mask stays on what it covers when the crop or straighten changes; lengths are fractions of
/// the picture's longer edge. Only the fields of its `kind` are set (and encoded).
public struct LocalAdjustment: Codable, Equatable, Hashable, Sendable {
    public var kind: String               // "graduated" | "radial" | "brush"
    public var exposure: Double = 0, contrast: Double = 0, warmth: Double = 0, tint: Double = 0, saturation: Double = 0
    // graduated: full effect at start, none from end on
    public var start: [Double]?, end: [Double]?
    // radial: an ellipse turned `angle` degrees clockwise, fading over the inner `feather` of its radius
    public var center: [Double]?, rx: Double?, ry: Double?, angle: Double?, feather: Double?, invert: Bool?
    // brush
    public var strokes: [BrushStroke]?

    enum CodingKeys: String, CodingKey {
        case kind, exposure, contrast, warmth, tint, saturation, start, end, center, rx, ry, angle, feather, invert, strokes
    }

    public init(kind: String) { self.kind = kind }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func num(_ k: CodingKeys) -> Double? { try? c.decode(Double.self, forKey: k) }
        kind = (try? c.decode(String.self, forKey: .kind)) ?? ""
        exposure = num(.exposure) ?? 0; contrast = num(.contrast) ?? 0; warmth = num(.warmth) ?? 0
        tint = num(.tint) ?? 0; saturation = num(.saturation) ?? 0
        start = try? c.decode([Double].self, forKey: .start); end = try? c.decode([Double].self, forKey: .end)
        center = try? c.decode([Double].self, forKey: .center)
        rx = num(.rx); ry = num(.ry); angle = num(.angle); feather = num(.feather)
        invert = try? c.decode(Bool.self, forKey: .invert)
        strokes = try? c.decode([BrushStroke].self, forKey: .strokes)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind)
        try c.encode(exposure, forKey: .exposure); try c.encode(contrast, forKey: .contrast)
        try c.encode(warmth, forKey: .warmth); try c.encode(tint, forKey: .tint); try c.encode(saturation, forKey: .saturation)
        try c.encodeIfPresent(start, forKey: .start); try c.encodeIfPresent(end, forKey: .end)
        try c.encodeIfPresent(center, forKey: .center); try c.encodeIfPresent(rx, forKey: .rx)
        try c.encodeIfPresent(ry, forKey: .ry); try c.encodeIfPresent(angle, forKey: .angle)
        try c.encodeIfPresent(feather, forKey: .feather); try c.encodeIfPresent(invert, forKey: .invert)
        try c.encodeIfPresent(strokes, forKey: .strokes)
    }

    static let maxCount = 16, maxStrokes = 64, maxPoints = 400

    /// `imaging._num`: clamped and rounded to 4 places (-0 never appears).
    static func num(_ v: Double?, _ lo: Double, _ hi: Double, _ d: Double = 0) -> Double {
        guard let v, v.isFinite else { return d }
        return (min(hi, max(lo, v)) * 10_000).rounded() / 10_000 + 0
    }

    static func point(_ v: [Double]?) -> [Double]? {
        guard let v, v.count == 2 else { return nil }
        return [num(v[0], -1, 2, 0.5), num(v[1], -1, 2, 0.5)]
    }

    /// `imaging.clean_local`: unknown kinds dropped, values clamped, each kind's defaults filled in.
    public static func clean(_ v: [LocalAdjustment]) -> [LocalAdjustment] {
        var out: [LocalAdjustment] = []
        for a in v.prefix(maxCount) where ["graduated", "radial", "brush"].contains(a.kind) {
            var c = LocalAdjustment(kind: a.kind)
            c.exposure = num(a.exposure, -1, 1); c.contrast = num(a.contrast, -1, 1); c.warmth = num(a.warmth, -1, 1)
            c.tint = num(a.tint, -1, 1); c.saturation = num(a.saturation, -1, 1)
            switch a.kind {
            case "graduated":
                c.start = point(a.start) ?? [0.5, 0.15]; c.end = point(a.end) ?? [0.5, 0.55]
            case "radial":
                c.center = point(a.center) ?? [0.5, 0.5]
                c.rx = num(a.rx, 0.005, 2, 0.25); c.ry = num(a.ry, 0.005, 2, 0.25)
                c.angle = num(a.angle, -180, 180); c.feather = num(a.feather, 0, 1, 0.5); c.invert = a.invert ?? false
            default:
                var strokes: [BrushStroke] = []
                for s in a.strokes ?? [] {
                    if strokes.count >= maxStrokes { break }
                    let pts = s.points.prefix(maxPoints).compactMap { point($0) }
                    if pts.isEmpty { continue }
                    strokes.append(BrushStroke(points: pts, radius: num(s.radius, 0.002, 0.5, 0.05),
                                               hardness: num(s.hardness, 0, 1, 0.5), flow: num(s.flow, 0, 1, 1), erase: s.erase))
                }
                c.strokes = strokes
            }
            out.append(c)
        }
        return out
    }

    /// `imaging.turn_local`: the adjustments of a slide turned clockwise by `rot` more degrees.
    public static func turned(_ local: [LocalAdjustment], by rot: Int) -> [LocalAdjustment] {
        let k = (((rot % 360) + 360) % 360) / 90
        guard k > 0, !local.isEmpty else { return local }
        func pt(_ p: [Double]) -> [Double] {
            var p = p
            for _ in 0..<k { p = [((1 - p[1]) * 10_000).rounded() / 10_000 + 0, p[0]] }
            return p
        }
        return local.map { a in
            var a = a
            if let s = a.start { a.start = pt(s) }
            if let e = a.end { a.end = pt(e) }
            if let c = a.center {
                a.center = pt(c)
                let t = (a.angle ?? 0) + Double(90 * k) + 180
                a.angle = (((t.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) - 180) * 10_000).rounded() / 10_000 + 0
            }
            a.strokes = a.strokes?.map { s in var s = s; s.points = s.points.map(pt); return s }
            return a
        }
    }
}

// MARK: - Masks and applying them

extension Develop {
    /// Masks are drawn on a grid this many cells along the picture's longer edge, at any resolution.
    public static let maskEdge = 1024
    static let exposureStops = 1.5        // what a local exposure of ±1 does (see localLook)

    @inline(__always) static func smooth(_ t: Double) -> Double { t * t * (3 - 2 * t) }

    /// `imaging.local_mask`: an adjustment's mask (0...1) for a `w` x `h` picture on the mask grid.
    /// Cell (i, j) is centred on picture point ((i + 0.5) / kx, (j + 0.5) / ky).
    public static func localMask(_ adj: LocalAdjustment, width w: Int, height h: Int) -> (width: Int, height: Int, data: [Float]) {
        let edge = Double(maskEdge)
        let s = Double(max(w, h))
        let kx = edge * Double(w) / s, ky = edge * Double(h) / s
        let gw = Int(kx.rounded(.up)), gh = Int(ky.rounded(.up))
        var m = [Float](repeating: 0, count: gw * gh)
        func cell(_ p: [Double]) -> (Double, Double) { (p[0] * kx - 0.5, p[1] * ky - 0.5) }
        func clamp01(_ v: Double) -> Double { min(1, max(0, v)) }
        switch adj.kind {
        case "brush":
            var acc = [Double](repeating: 0, count: gw * gh)
            for st in adj.strokes ?? [] {
                let rad = st.radius * edge
                let pts = st.points.map(cell)
                let segs = pts.count > 1 ? Array(zip(pts, pts.dropFirst())) : [(pts[0], pts[0])]
                let xs = pts.map { $0.0 }, ys = pts.map { $0.1 }
                let x0 = max(0, Int((xs.min()! - rad).rounded(.down))), x1 = min(gw, Int((xs.max()! + rad).rounded(.up)) + 1)
                let y0 = max(0, Int((ys.min()! - rad).rounded(.down))), y1 = min(gh, Int((ys.max()! + rad).rounded(.up)) + 1)
                if x0 >= x1 || y0 >= y1 { continue }
                let bw = x1 - x0
                var d2 = [Double](repeating: .infinity, count: bw * (y1 - y0))
                for ((ax, ay), (bx, by)) in segs {   // each segment only near itself
                    let sx0 = max(x0, Int((min(ax, bx) - rad).rounded(.down))), sx1 = min(x1, Int((max(ax, bx) + rad).rounded(.up)) + 1)
                    let sy0 = max(y0, Int((min(ay, by) - rad).rounded(.down))), sy1 = min(y1, Int((max(ay, by) + rad).rounded(.up)) + 1)
                    if sx0 >= sx1 || sy0 >= sy1 { continue }
                    let vx = bx - ax, vy = by - ay, ll = vx * vx + vy * vy
                    for y in sy0..<sy1 {
                        for x in sx0..<sx1 {
                            let t = ll > 0 ? clamp01(((Double(x) - ax) * vx + (Double(y) - ay) * vy) / ll) : 0
                            let dx = Double(x) - (ax + t * vx), dy = Double(y) - (ay + t * vy)
                            let i = (y - y0) * bw + (x - x0)
                            d2[i] = min(d2[i], dx * dx + dy * dy)
                        }
                    }
                }
                let soft = max(1 - st.hardness, 1e-3)
                for y in y0..<y1 {
                    for x in x0..<x1 {
                        let u = d2[(y - y0) * bw + (x - x0)].squareRoot() / rad
                        let c = st.flow * (1 - smooth(clamp01((u - st.hardness) / soft)))
                        let i = y * gw + x
                        acc[i] = st.erase ? acc[i] * (1 - c) : acc[i] + c * (1 - acc[i])
                    }
                }
            }
            for i in 0..<acc.count { m[i] = Float(acc[i]) }
        case "graduated":
            let (ax, ay) = cell(adj.start ?? [0.5, 0.15]), (bx, by) = cell(adj.end ?? [0.5, 0.55])
            let vx = bx - ax, vy = by - ay, ll = max(vx * vx + vy * vy, 1e-9)
            for y in 0..<gh {
                for x in 0..<gw { m[y * gw + x] = Float(1 - smooth(clamp01(((Double(x) - ax) * vx + (Double(y) - ay) * vy) / ll))) }
            }
        default:   // radial
            let (cx, cy) = cell(adj.center ?? [0.5, 0.5])
            let th = (adj.angle ?? 0) * .pi / 180   // clockwise on screen
            let cs = cos(th), sn = sin(th)
            let rx = (adj.rx ?? 0.25) * edge, ry = (adj.ry ?? 0.25) * edge, f = max(adj.feather ?? 0.5, 1e-3)
            let invert = adj.invert ?? false
            for y in 0..<gh {
                for x in 0..<gw {
                    let dx = Double(x) - cx, dy = Double(y) - cy
                    let qx = (dx * cs + dy * sn) / rx, qy = (-dx * sn + dy * cs) / ry
                    let v = smooth(clamp01((1 - (qx * qx + qy * qy).squareRoot()) / f))
                    m[y * gw + x] = Float(invert ? 1 - v : v)
                }
            }
        }
        return (gw, gh, m)
    }

    /// `imaging.local_look` on one pixel: white balance, exposure (a gamma lift up, a scale down),
    /// contrast, saturation.
    @inline(__always) static func localLook(_ px: inout (Double, Double, Double), _ adj: LocalAdjustment) {
        let eps = 1e-5
        func c01(_ v: Double) -> Double { min(1, max(eps, v)) }
        if adj.warmth != 0 || adj.tint != 0 {
            px = (pow(c01(px.0), 1 - 0.25 * adj.warmth), pow(c01(px.1), 1 + 0.25 * adj.tint), pow(c01(px.2), 1 + 0.25 * adj.warmth))
        }
        if adj.exposure > 0 {
            let g = pow(2, -exposureStops * adj.exposure)
            px = (pow(c01(px.0), g), pow(c01(px.1), g), pow(c01(px.2), g))
        } else if adj.exposure < 0 {
            let f = pow(2, exposureStops * adj.exposure)
            px = (px.0 * f, px.1 * f, px.2 * f)
        }
        let con = adj.contrast
        if con > 0 {
            func s(_ v: Double) -> Double { v + (v * v * (3 - 2 * v) - v) * con * 1.5 }
            px = (s(px.0), s(px.1), s(px.2))
        } else if con < 0 {
            func s(_ v: Double) -> Double { v + (0.5 - v) * -con * 0.5 }
            px = (s(px.0), s(px.1), s(px.2))
        }
        if adj.saturation != 0 {
            let lum = px.0 * 0.299 + px.1 * 0.587 + px.2 * 0.114, k = 1 + adj.saturation
            px = (lum + (px.0 - lum) * k, lum + (px.1 - lum) * k, lum + (px.2 - lum) * k)
        }
        px = (min(1, max(0, px.0)), min(1, max(0, px.1)), min(1, max(0, px.2)))
    }

    /// `imaging.apply_local`, in place, after the global develop. `frame` is the straightened frame
    /// `a` was cut from at `at`; each pixel is traced back through the straighten to the picture,
    /// where the masks are sampled bilinearly from their grids. Adjustments apply in order.
    public static func applyLocal(_ a: inout RGBImage, _ local: [LocalAdjustment], frame: (w: Int, h: Int),
                                  at: (x: Int, y: Int), angle: Double) {
        guard !local.isEmpty else { return }
        let w = Double(frame.w), h = Double(frame.h)
        let k = Double(maskEdge) / max(w, h)   // picture pixels -> cells
        let masks = local.map { localMask($0, width: frame.w, height: frame.h) }
        let gw = masks[0].width, gh = masks[0].height
        let turned = abs(angle) >= 0.01   // straighten() leaves tiny angles alone
        let th = abs(angle) * .pi / 180
        let scale = cos(th) + sin(th) * max(w, h) / min(w, h)
        let cs = cos(angle * .pi / 180) / scale, sn = sin(angle * .pi / 180) / scale
        let width = a.width, height = a.height
        a.data.withUnsafeMutableBufferPointer { o in
          let o = o
          parallelFor(height, minChunk: 8) { rows in
            for y in rows {
                for x in 0..<width {
                    var sx = Double(x + at.x), sy = Double(y + at.y)
                    if turned {
                        let dx = sx - w / 2, dy = sy - h / 2
                        sx = w / 2 + cs * dx + sn * dy; sy = h / 2 - sn * dx + cs * dy
                    }
                    let gx = (sx + 0.5) * k - 0.5, gy = (sy + 0.5) * k - 0.5
                    let ix = Int(gx.rounded(.down)), iy = Int(gy.rounded(.down))
                    let fx = gx - Double(ix), fy = gy - Double(iy)
                    let xa = min(gw - 1, max(0, ix)), xb = min(gw - 1, max(0, ix + 1))
                    let ya = min(gh - 1, max(0, iy)) * gw, yb = min(gh - 1, max(0, iy + 1)) * gw
                    let i = (y * width + x) * 3
                    for n in 0..<local.count {
                        let g = masks[n].data
                        let m = (Double(g[ya + xa]) * (1 - fx) + Double(g[ya + xb]) * fx) * (1 - fy)
                            + (Double(g[yb + xa]) * (1 - fx) + Double(g[yb + xb]) * fx) * fy
                        if !(m > 0) { continue }
                        var px = (Double(o[i]), Double(o[i + 1]), Double(o[i + 2]))
                        localLook(&px, local[n])
                        o[i] += Float((px.0 - Double(o[i])) * m)
                        o[i + 1] += Float((px.1 - Double(o[i + 1])) * m)
                        o[i + 2] += Float((px.2 - Double(o[i + 2])) * m)
                    }
                }
            }
          }
        }
    }
}
