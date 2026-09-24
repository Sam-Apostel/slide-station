import Foundation

// MARK: - Shared by the repairs

extension Develop {
    /// A proxy-scale mask at w × h: every pixel takes its proxy pixel's verdict (Python: `_verdicts`).
    static func verdicts(_ m: [UInt8], _ mw: Int, _ mh: Int, _ w: Int, _ h: Int) -> [UInt8] {
        if mw == w && mh == h { return m }
        let xs = (0..<w).map { min(Int((Double($0) + 0.5) * Double(mw) / Double(w)), mw - 1) }
        var out = [UInt8](repeating: 0, count: w * h)
        for y in 0..<h {
            let my = min(Int((Double(y) + 0.5) * Double(mh) / Double(h)), mh - 1) * mw
            for x in 0..<w { out[y * w + x] = m[my + xs[x]] }
        }
        return out
    }

    /// For each of n pixels, the two of sn grid centres around it and the weight of the second, the
    /// grid spanning the same length, clamped at the ends (Python: `_bilinear_axis`).
    static func bilinearAxis(_ n: Int, _ sn: Int) -> (i0: [Int], i1: [Int], f: [Double]) {
        var i0 = [Int](repeating: 0, count: n), i1 = i0, f = [Double](repeating: 0, count: n)
        for k in 0..<n {
            let u = (Double(k) + 0.5) * Double(sn) / Double(n) - 0.5
            i0[k] = min(sn - 1, max(0, Int(u.rounded(.down))))
            i1[k] = min(i0[k] + 1, sn - 1)
            f[k] = min(1, max(0, u - Double(i0[k])))
        }
        return (i0, i1, f)
    }
}

// MARK: - Mould

extension Develop {
    static let mouldCells = 9    // the picture under the mould: the median of this many cells (4r px each) across
    static let mouldLong = 40    // × r: the longest colony, in proxy pixels (120 at 1600 px, ~2.7 mm of the film)
    static let mouldPasses = 6

    /// The picture without its mould, per channel and ×9 (Python: `_mould_background`): the lower
    /// median of the mouldCells² integer cell means around each cell, bilinear between cells.
    static func mouldBackground(_ q: [Int], _ w: Int, _ h: Int, cell: Int) -> [Double] {
        let gw = (w + cell - 1) / cell, gh = (h + cell - 1) / cell
        var cells = [Int](repeating: 0, count: gw * gh * 3)
        for gy in 0..<gh {
            for gx in 0..<gw {
                let y0 = gy * cell, y1 = min(h, y0 + cell), x0 = gx * cell, x1 = min(w, x0 + cell)
                let n = (y1 - y0) * (x1 - x0)
                for c in 0..<3 {
                    var sum = 0
                    for y in y0..<y1 { for x in x0..<x1 { sum += q[(y * w + x) * 3 + c] } }
                    cells[(gy * gw + gx) * 3 + c] = sum * 9 / n
                }
            }
        }
        let k = mouldCells / 2
        var med = [Double](repeating: 0, count: gw * gh * 3)
        for gy in 0..<gh {
            for gx in 0..<gw {
                for c in 0..<3 {
                    var win: [Int] = []
                    for y in max(0, gy - k)...min(gh - 1, gy + k) {
                        for x in max(0, gx - k)...min(gw - 1, gx + k) { win.append(cells[(y * gw + x) * 3 + c]) }
                    }
                    win.sort()
                    med[(gy * gw + gx) * 3 + c] = Double(win[(win.count - 1) / 2])
                }
            }
        }
        // bilinear between the cells' centres, rows first (Python: `_upsample`)
        let ax = bilinearAxis(gw * cell, gw), ay = bilinearAxis(gh * cell, gh)
        var across = [Double](repeating: 0, count: gh * w * 3)
        for gy in 0..<gh {
            for x in 0..<w {
                let f = ax.f[x]
                for c in 0..<3 {
                    across[(gy * w + x) * 3 + c] = med[(gy * gw + ax.i0[x]) * 3 + c] * (1 - f) + med[(gy * gw + ax.i1[x]) * 3 + c] * f
                }
            }
        }
        var bg = [Double](repeating: 0, count: w * h * 3)
        for y in 0..<h {
            let r0 = ay.i0[y] * w * 3, r1 = ay.i1[y] * w * 3, f = ay.f[y]
            for i in 0..<(w * 3) { bg[y * w * 3 + i] = across[r0 + i] * (1 - f) + across[r1 + i] * f }
        }
        return bg
    }

    /// Max over the (2g + 1)² window clipped to the image (cv2.dilate of a 0/1 mask).
    static func grow(_ m: [UInt8], _ w: Int, _ h: Int, _ g: Int) -> [UInt8] {
        var across = [UInt8](repeating: 0, count: w * h), out = across
        for y in 0..<h {
            for x in 0..<w where (max(0, x - g)...min(w - 1, x + g)).contains(where: { m[y * w + $0] != 0 }) { across[y * w + x] = 1 }
        }
        for y in 0..<h {
            for x in 0..<w where (max(0, y - g)...min(h - 1, y + g)).contains(where: { across[$0 * w + x] != 0 }) { out[y * w + x] = 1 }
        }
        return out
    }

    /// Mould (Python: `_find_mould`): candidates where a channel's 3×3 sum differs from the picture
    /// without its mould by more than `amount` asks, joined into 8-connected shapes (at half the
    /// threshold, with a pixel over it); shapes bigger than dust, at most mouldLong × r long and
    /// filling little of their bounding box are mould, grown by r / 2. Integers throughout, so the
    /// same pixels as Python. Returns the mask, every candidate, the background (×9) and r.
    static func findMould(_ a: RGBImage, amount: Double) -> (mask: [UInt8], busy: [UInt8], bg: [Double], r: Int) {
        let w = a.width, h = a.height
        let q = a.data.map { Int(min(1, max(0, $0)) * 255 + 0.5) }   // Float arithmetic, like numpy's float32
        let r = max(1, Int(3 * Double(max(w, h)) / Double(dustEdge) + 0.5))
        let bg = mouldBackground(q, w, h, cell: 4 * r)
        let thr = 9 * (30 - 18 * amount)
        var s3 = [Int](repeating: 0, count: w * h * 3)   // the 3×3 sums, the edge repeated: across, then down
        for y in 0..<h {
            for x in 0..<w {
                let i = (y * w + x) * 3, l = (y * w + max(0, x - 1)) * 3, rt = (y * w + min(w - 1, x + 1)) * 3
                for c in 0..<3 { s3[i + c] = q[l + c] + q[i + c] + q[rt + c] }
            }
        }
        var dev = [Double](repeating: 0, count: w * h)
        for y in 0..<h {
            let up = max(0, y - 1) * w * 3, down = min(h - 1, y + 1) * w * 3
            for x in 0..<w {
                var d = 0.0
                for c in 0..<3 {
                    let i = (y * w + x) * 3 + c
                    d = max(d, abs(Double(s3[up + x * 3 + c] + s3[i] + s3[down + x * 3 + c]) - bg[i]))
                }
                dev[y * w + x] = d
            }
        }
        // 8-connected shapes of the weak candidates, by flood fill: their size, extent, strength
        struct Shape { var area = 0, x0 = Int.max, x1 = 0, y0 = Int.max, y1 = 0, strong = false }
        var label = [Int](repeating: 0, count: w * h)
        var shapes: [Shape] = []
        var stack: [Int] = []
        for i in 0..<(w * h) where label[i] == 0 && dev[i] > thr / 2 {
            var s = Shape()
            shapes.append(s)
            label[i] = shapes.count
            stack.append(i)
            while let j = stack.popLast() {
                let y = j / w, x = j % w
                s.area += 1
                s.x0 = min(s.x0, x); s.x1 = max(s.x1, x); s.y0 = min(s.y0, y); s.y1 = max(s.y1, y)
                if dev[j] > thr { s.strong = true }
                for yy in max(0, y - 1)...min(h - 1, y + 1) {
                    for xx in max(0, x - 1)...min(w - 1, x + 1) {
                        let k = yy * w + xx
                        if label[k] == 0 && dev[k] > thr / 2 { label[k] = shapes.count; stack.append(k) }
                    }
                }
            }
            shapes[shapes.count - 1] = s
        }
        let fill = Int(35 + 20 * amount)
        let keep = shapes.map { s -> Bool in
            let bw = s.x1 - s.x0 + 1, bh = s.y1 - s.y0 + 1
            return s.strong && s.area >= 3 * r * r && max(bw, bh) <= mouldLong * r && s.area * 100 <= bw * bh * fill
        }
        var kept = [UInt8](repeating: 0, count: w * h), busy = kept
        for i in 0..<(w * h) where label[i] != 0 {
            busy[i] = 1
            if keep[label[i] - 1] { kept[i] = 1 }
        }
        return (grow(kept, w, h, max(1, Int(Double(r) / 2 + 0.5))), busy, bg, r)
    }

    /// The mould `findMould` keeps (Python: `mould_mask`).
    public static func mouldMask(_ a: RGBImage, amount: Double) -> (mask: [UInt8], r: Int) {
        let f = findMould(a, amount: amount)
        return (f.mask, f.r)
    }

    public static func repairMould(_ a: RGBImage, amount: Double) -> RGBImage {
        var out = a
        repairMouldInPlace(&out, amount: amount)
        return out
    }

    /// Find mould (at proxy scale) and paint it out without leaving flat patches (Python:
    /// `repair_mould`): low frequencies from the median of the clean proxy pixels around (9 × 9
    /// samples r apart, pass by pass), grain from the first clean spot 6r or 12r away round the
    /// compass (its pixel minus its local mean). At full resolution the low frequencies are the
    /// proxy's, bilinear.
    public static func repairMouldInPlace(_ a: inout RGBImage, amount: Double) {
        guard amount > 0 else { return }
        let w = a.width, h = a.height
        let small = shrink(a, dustEdge)
        let found = findMould(small, amount: amount)
        var m = found.mask, busy0 = found.busy
        let bg = found.bg, r = found.r
        guard m.contains(1) else { return }
        let mw = small.width, mh = small.height
        // samples and grain come from clean picture only, not from mould left alone
        var known = [UInt8](repeating: 0, count: mw * mh)
        var todo: [Int] = []
        for i in 0..<(mw * mh) {
            if m[i] != 0 { busy0[i] = 1; todo.append(i) }
            known[i] = 1 - busy0[i]
        }
        var low = small
        let off = (-4...4).map { $0 * r }
        for i in medianFill(&low, known: &known, todo: todo, off: off, passes: mouldPasses) {
            for c in 0..<3 { low.data[i * 3 + c] = Float(bg[i * 3 + c] / (9 * 255)) }
        }
        m = verdicts(m, mw, mh, w, h)
        let busy = verdicts(busy0, mw, mh, w, h)
        let ax = bilinearAxis(w, mw), ay = bilinearAxis(h, mh)
        let f = Double(max(h, w)) / Double(max(mh, mw))
        let g = max(1, Int(f + 0.5)), n = Double((2 * g + 1) * (2 * g + 1))
        var shifts: [(Int, Int)] = []
        for d in [6 * r, 12 * r] {
            let s = Int(Double(d) * f + 0.5)
            for (sy, sx) in [(0, 1), (0, -1), (1, 0), (-1, 0), (1, 1), (-1, -1), (1, -1), (-1, 1)] { shifts.append((sy * s, sx * s)) }
        }
        let src = a.data, L = low.data
        var at: [Int] = [], vals: [Double] = []   // written once every value is known
        for y in 0..<h {
            for x in 0..<w where m[y * w + x] != 0 {
                let x0 = ax.i0[x], x1 = ax.i1[x], fx = ax.f[x], y0 = ay.i0[y], y1 = ay.i1[y], fy = ay.f[y]
                var v = [Double](repeating: 0, count: 3)
                for c in 0..<3 {
                    let top = Double(L[(y0 * mw + x0) * 3 + c]) * (1 - fx) + Double(L[(y0 * mw + x1) * 3 + c]) * fx
                    let bottom = Double(L[(y1 * mw + x0) * 3 + c]) * (1 - fx) + Double(L[(y1 * mw + x1) * 3 + c]) * fx
                    v[c] = top * (1 - fy) + bottom * fy
                }
                if let shift = shifts.first(where: { sh in
                    let yy = y + sh.0, xx = x + sh.1
                    return yy >= 0 && yy < h && xx >= 0 && xx < w && busy[yy * w + xx] == 0
                }) {
                    // the grain: that pixel minus the mean of the (2g + 1)² around it, g a proxy pixel
                    let qy = y + shift.0, qx = x + shift.1
                    var mean = [0.0, 0.0, 0.0]
                    for oy in -g...g {
                        let yy = min(h - 1, max(0, qy + oy))
                        for ox in -g...g {
                            let s = (yy * w + min(w - 1, max(0, qx + ox))) * 3
                            for c in 0..<3 { mean[c] += Double(src[s + c]) }
                        }
                    }
                    for c in 0..<3 { v[c] += Double(src[(qy * w + qx) * 3 + c]) - mean[c] / n }
                }
                at.append(y * w + x)
                vals += v
            }
        }
        for (k, i) in at.enumerated() {
            for c in 0..<3 { a.data[i * 3 + c] = Float(min(1, max(0, vals[k * 3 + c]))) }
        }
    }
}

// MARK: - Newton rings

extension Develop {
    public static let newtonEdge = 1600

    /// Mean over the (2r + 1)² window clipped to the image, in place, from Double running sums:
    /// along rows, then down columns (Python: `_box`; OpenCV adds in another order, ~1e-15 apart).
    /// `run` is scratch space for (h + 1) × w values.
    static func box(_ a: inout [Double], _ w: Int, _ h: Int, _ r: Int, run: inout [Double]) {
        guard r > 0 else { return }
        for y in 0..<h {
            let row = y * w
            run[0] = 0
            for x in 0..<w { run[x + 1] = run[x] + a[row + x] }
            for x in 0..<w {
                let lo = max(x - r, 0), hi = min(x + r + 1, w)
                a[row + x] = (run[hi] - run[lo]) / Double(hi - lo)
            }
        }
        // down the columns: every column's running sum at once, a row at a time
        for x in 0..<w { run[x] = 0 }
        for y in 0..<h { for x in 0..<w { run[(y + 1) * w + x] = run[y * w + x] + a[y * w + x] } }
        for y in 0..<h {
            let lo = max(y - r, 0), hi = min(y + r + 1, h), n = Double(hi - lo)
            for x in 0..<w { a[y * w + x] = (run[hi * w + x] - run[lo * w + x]) / n }
        }
    }

    /// Two box means, in place: close to a Gaussian (Python: `_blur`).
    static func blur(_ a: inout [Double], _ w: Int, _ h: Int, _ r: Int, run: inout [Double]) {
        box(&a, w, h, r, run: &run)
        box(&a, w, h, r, run: &run)
    }

    static func smoothstep(_ x: Double, _ e0: Double, _ e1: Double) -> Double {
        let t = min(1, max(0, (x - e0) / (e1 - e0)))
        return t * t * (3 - 2 * t)
    }

    /// Newton rings (Python: `newton_weight`): where the band between two blurs is narrow-band (one
    /// frequency: gradient energy² ≈ energy × Laplacian energy), oriented (structure tensor) and
    /// faint. Spatial rather than an FFT: the rings' period changes across the frame. Returns the
    /// weight 0...1 per pixel and the band per channel.
    public static func newtonWeight(_ a: RGBImage, amount: Double) -> (weight: [Double], band: [[Double]]) {
        let w = a.width, h = a.height, N = w * h
        let s = Double(max(h, w)) / Double(newtonEdge)
        let r1 = Int(s + 0.5)   // 0: no blur
        let r2 = max(2, Int(14 * s + 0.5)), r3 = max(3, Int(20 * s + 0.5))
        var run = [Double](repeating: 0, count: (h + 1) * w + 1)
        var sums = [[Double]](repeating: [Double](repeating: 0, count: N), count: 5)   // e0, e2, jxx, jyy, jxy
        var band: [[Double]] = []
        for c in 0..<3 {
            var lo = (0..<N).map { Double(a.data[$0 * 3 + c]) }, hi = lo
            blur(&lo, w, h, r1, run: &run)
            blur(&hi, w, h, r2, run: &run)
            for i in 0..<N { lo[i] -= hi[i] }
            var b = lo
            blur(&b, w, h, max(1, 2 * r1), run: &run)
            for y in 0..<h {
                for x in 0..<w {
                    let i = y * w + x
                    let xp = b[y * w + min(x + 1, w - 1)], xm = b[y * w + max(x - 1, 0)]
                    let yp = b[min(y + 1, h - 1) * w + x], ym = b[max(y - 1, 0) * w + x]
                    let gx = (xp - xm) * 0.5, gy = (yp - ym) * 0.5
                    let lap = xp + xm + yp + ym - 4 * b[i]
                    // summed over the channels in order, as (c0 + c1) + c2
                    sums[0][i] += b[i] * b[i]; sums[1][i] += lap * lap
                    sums[2][i] += gx * gx; sums[3][i] += gy * gy; sums[4][i] += gx * gy
                }
            }
            band.append(lo)
        }
        for k in 0..<5 { blur(&sums[k], w, h, r3, run: &run) }
        let n0 = 0.6 - 0.15 * amount, c0 = 0.5 - 0.25 * amount, a1 = 0.02 + 0.04 * amount
        var weight = [Double](repeating: 0, count: N)
        for i in 0..<N {
            let e0 = sums[0][i], e2 = sums[1][i], jxx = sums[2][i], jyy = sums[3][i], jxy = sums[4][i]
            let e1 = jxx + jyy
            let narrow = e1 * e1 / (e0 * e2 + 1e-30)
            let coh = ((jxx - jyy) * (jxx - jyy) + 4 * jxy * jxy) / (e1 * e1 + 1e-30)
            let amp = e0.squareRoot()
            weight[i] = smoothstep(narrow, n0, n0 + 0.15) * smoothstep(coh, c0, c0 + 0.25)
                * smoothstep(amp, 0.001, 0.003) * (1 - smoothstep(amp, a1, 2 * a1))
        }
        return (weight, band)
    }

    public static func repairNewton(_ a: RGBImage, amount: Double) -> RGBImage {
        var out = a
        repairNewtonInPlace(&out, amount: amount)
        return out
    }

    /// Take the ring band out where `newtonWeight` finds rings, at proxy scale; at full resolution
    /// the proxy's correction is laid on bilinear (Python: `repair_newton`).
    public static func repairNewtonInPlace(_ a: inout RGBImage, amount: Double) {
        guard amount > 0 else { return }
        let w = a.width, h = a.height
        let small = shrink(a, newtonEdge)
        let mw = small.width, mh = small.height
        let (weight, band) = newtonWeight(small, amount: amount)
        var corr = [Double](repeating: 0, count: mw * mh * 3)
        for i in 0..<(mw * mh) { for c in 0..<3 { corr[i * 3 + c] = -weight[i] * band[c][i] } }
        let ax = bilinearAxis(w, mw), ay = bilinearAxis(h, mh)
        // bilinear, along rows first, then down (Python: `_upsample`); proxy rows brought across as needed
        var rows: [Int: [Double]] = [:]
        func across(_ y: Int) -> [Double] {
            if let row = rows[y] { return row }
            var row = [Double](repeating: 0, count: w * 3)
            for x in 0..<w {
                let f = ax.f[x]
                for c in 0..<3 { row[x * 3 + c] = corr[(y * mw + ax.i0[x]) * 3 + c] * (1 - f) + corr[(y * mw + ax.i1[x]) * 3 + c] * f }
            }
            rows = rows.filter { $0.key >= y - 1 }
            rows[y] = row
            return row
        }
        for y in 0..<h {
            let r0 = across(ay.i0[y]), r1 = across(ay.i1[y]), f = ay.f[y]
            for i in 0..<(w * 3) {
                let k = y * w * 3 + i
                a.data[k] = Float(min(1, max(0, Double(a.data[k]) + (r0[i] * (1 - f) + r1[i] * f))))
            }
        }
    }
}
