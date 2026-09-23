import CoreGraphics
import Foundation
import Vision

/// Grouping scans into slides, picking the best of a bracket, and guessing rotation
/// (Python: `imaging.signature` … `imaging.suggest_rotation`).
public enum Brackets {
    // MARK: grouping

    public static let sameSlide: Float = 0.86

    /// Brightness-independent structural signature (96 × 64, zero mean, unit variance).
    public static func signature(_ rgb: RGBImage) -> [Float] {
        var g = rgb.gray()
        g.data = g.data.map { ($0 * 255).rounded() }
        let s = g.resized(width: 96, height: 64)
        let m = s.mean, sd = s.std
        return s.data.map { ($0 - m) / (sd + 1e-6) }
    }

    public static func similarity(_ a: [Float], _ b: [Float]) -> Float {
        guard a.count == b.count, !a.isEmpty else { return 0 }
        var acc: Float = 0
        for i in 0..<a.count { acc += a[i] * b[i] }
        return acc / Float(a.count)
    }

    /// Chain consecutive scans that look like the same slide (compared against every scan in the
    /// current group). Returns the groups of indices and whether the first scan continues `previous`.
    public static func groupSequence(_ sigs: [[Float]], previous: [[Float]]? = nil) -> (groups: [[Int]], continues: Bool) {
        var groups: [[Int]] = []
        var continues = false
        for (i, s) in sigs.enumerated() {
            let members = groups.last.map { $0.map { sigs[$0] } } ?? (previous ?? [])
            if !members.isEmpty, members.map({ similarity(s, $0) }).max()! > sameSlide {
                if groups.isEmpty { continues = true; groups.append([i]) } else { groups[groups.count - 1].append(i) }
            } else {
                groups.append([i])
            }
        }
        return (groups, continues)
    }

    // MARK: best of a bracket

    public struct Quality: Codable, Equatable, Sendable { public var sharp: Double; public var clipped: Double }

    /// Sharpness (independent of exposure) and how much of the frame is clipped, for one scan.
    public static func quality(_ rgb: RGBImage) -> Quality {
        var g = rgb.gray()
        g.data = g.data.map { (min(1, max(0, $0)) * 255).rounded() }
        g = g.resized(width: 800, height: Int(800 * Double(g.height) / Double(g.width)))
        g.data = g.data.map { $0.rounded() }
        let h = g.height, w = g.width
        let t = h / 10, l = w / 10
        var core = Plane(width: w - 2 * l, height: h - 2 * t)
        for y in 0..<core.height { for x in 0..<core.width { core[x, y] = g[x + l, y + t] } }
        let litMask = core.data.map { $0 > 12 && $0 < 243 }
        let lit = zip(core.data, litMask).compactMap { $1 ? $0 : nil }
        let clipped = 1 - Double(lit.count) / Double(core.data.count)
        let round3 = { (v: Double) in (v * 1000).rounded() / 1000 }
        if Double(lit.count) < Double(core.data.count) * 0.05 { return Quality(sharp: 0, clipped: round3(clipped)) }
        let lap = Filters.laplacian(Filters.gaussianBlur(core, sigma: 0.8))
        var acc: Double = 0
        for (i, m) in litMask.enumerated() where m { acc += Double(abs(lap.data[i])) }
        let mean = lit.reduce(0, +) / Float(lit.count)
        let std = Double((lit.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Float(lit.count)).squareRoot())
        let sharp = acc / Double(lit.count) / (std + 1e-3)
        return Quality(sharp: (sharp * 10_000).rounded() / 10_000, clipped: round3(clipped))
    }

    public static let blurry = 0.6   // below this share of the stack's sharpest scan, a scan is left out
    public static let clipped = 0.85

    /// Which scans of a bracket to leave out, and why ("blurry" / "clipped"). Always keeps one.
    public static func weakScans(_ q: [Quality]) -> [Int: String] {
        guard q.count >= 2 else { return [:] }
        let best = q.map(\.sharp).max().flatMap { $0 > 0 ? $0 : nil } ?? 1
        var out: [Int: String] = [:]
        for (i, x) in q.enumerated() {
            if x.clipped > clipped { out[i] = "clipped" } else if x.sharp < blurry * best { out[i] = "blurry" }
        }
        if out.count == q.count, let keep = q.indices.max(by: { q[$0].sharp < q[$1].sharp }) { out[keep] = nil }
        return out
    }

    // MARK: rotation

    /// Confident, upright faces found when the image is turned by each candidate rotation.
    /// Vision stands in for YuNet: faces whose roll is more than ~30° off upright don't count, so a
    /// face only votes for the rotation that makes it stand up.
    public static func faceVotes(_ cg: CGImage) -> [Int: Double] {
        var votes: [Int: Double] = [:]
        let orientations: [Int: CGImagePropertyOrientation] = [0: .up, 90: .right, 180: .down, 270: .left]
        for (rot, orientation) in orientations {
            let request = VNDetectFaceRectanglesRequest()
            let handler = VNImageRequestHandler(cgImage: cg, orientation: orientation, options: [:])
            try? handler.perform([request])
            votes[rot] = (request.results ?? []).reduce(0) { acc, face in
                let roll = abs(face.roll?.doubleValue ?? 0)
                return face.confidence >= 0.7 && roll < 0.55 ? acc + Double(face.confidence) : acc
            }
        }
        return votes
    }

    /// Bright, smooth, blue-ish edge = sky. Score per rotation (which edge would become the top).
    public static func skyVotes(_ rgb: RGBImage) -> [Int: Double] {
        let s = rgb.resized(width: 480, height: 320)
        let h = s.height, w = s.width
        var lum = Plane(width: w, height: h), blue = Plane(width: w, height: h)
        for i in 0..<(w * h) {
            lum.data[i] = (s.data[i * 3] + s.data[i * 3 + 1] + s.data[i * 3 + 2]) / 3
            blue.data[i] = s.data[i * 3 + 2] - s.data[i * 3]
        }
        let tex = Filters.laplacian(Filters.gaussianBlur(lum, sigma: 1))
        let sh = h / 5, sw = w / 5
        func score(_ xs: Range<Int>, _ ys: Range<Int>) -> Double {
            var l = 0.0, b = 0.0, t = 0.0
            for y in ys { for x in xs { l += Double(lum[x, y]); b += Double(blue[x, y]); t += Double(abs(tex[x, y])) } }
            let n = Double(xs.count * ys.count)
            return l / n + 0.5 * b / n - 8 * t / n
        }
        return [0: score(0..<w, 0..<sh), 90: score(0..<sw, 0..<h), 270: score((w - sw)..<w, 0..<h), 180: score(0..<w, (h - sh)..<h)]
    }

    /// Clockwise rotation that makes a slide upright, from one or more scans of it, and why
    /// ("faces", "sky", or "" = no confident guess → 0). Only guesses when it is very likely right.
    public static func suggestRotation(_ images: [RGBImage]) -> (Int, String) {
        let n = Double(images.count)
        guard n > 0 else { return (0, "") }
        var fv: [Int: Double] = [0: 0, 90: 0, 180: 0, 270: 0]
        for im in images {
            let small = im.fitting(maxEdge: 800)
            for (r, v) in faceVotes(ImageFile.cgImage(small)) { fv[r, default: 0] += v }
        }
        let best = fv.max { $0.value < $1.value }!
        let second = fv.values.sorted()[2]
        if best.value / n >= 0.7 && best.value >= second * 2 + 0.3 * n { return (best.key, "faces") }
        var sv: [Int: Double] = [0: 0, 90: 0, 180: 0, 270: 0]
        for im in images { for (r, v) in skyVotes(im) { sv[r, default: 0] += v / n } }
        let ranked = sv.sorted { $0.value > $1.value }
        if [90, 270].contains(ranked[0].key) && ranked[0].value - ranked[1].value >= 0.2 { return (ranked[0].key, "sky") }
        return (0, "")
    }
}
