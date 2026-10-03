import Foundation
import SlideKit

/// What someone wears (`people.describe_clothes`): a colour histogram (Lab; 4 × 6 × 6 bins, a and b
/// over -40...40; summing to 1) of the chest below a face, weighted to its middle so the background
/// counts little. On the slides around a named face, a face a little like theirs in the same
/// clothes is them (`People.spread`).
public enum Clothes {
    static let bins = (l: 4, a: 6, b: 6)
    /// faces.json entries say which clothes description they have: older ones are redone.
    public static let version = 1

    /// Nil when there's no room below the face (it's at the bottom edge). `box` as stored: 0...1 of
    /// the upright picture, (x, y, w, h).
    public static func describe(_ rgb: RGBImage, box: [Double]) -> [Float]? {
        let w = Double(rgb.width), h = Double(rgb.height)
        let x = box[0] * w, y = box[1] * h, bw = box[2] * w, bh = box[3] * h
        let cx = x + bw / 2, cy = y + 2.3 * bh
        let x0 = Int(max(0, cx - 1.2 * bw)), x1 = Int(min(w, cx + 1.2 * bw))
        let y0 = Int(max(0, y + 1.3 * bh)), y1 = Int(min(h, y + 3.3 * bh))
        guard x1 - x0 >= 4, Double(y1 - y0) >= max(4, 0.5 * bh) else { return nil }
        var crop = rgb.cropped(top: y0, bottom: y1, left: x0, right: x1)
        for i in crop.data.indices { crop.data[i] = min(1, max(0, crop.data[i])) }
        let cw = min(48, x1 - x0), ch = min(48, y1 - y0)
        if cw != crop.width || ch != crop.height { crop = crop.resized(width: cw, height: ch) }
        var hist = [Double](repeating: 0, count: bins.l * bins.a * bins.b)
        for j in 0..<ch {
            let ys = Double(y0) + (Double(j) + 0.5) * Double(y1 - y0) / Double(ch)
            for i in 0..<cw {
                let xs = Double(x0) + (Double(i) + 0.5) * Double(x1 - x0) / Double(cw)
                let wt = exp(-0.5 * (pow((ys - cy) / bh, 2) + pow((xs - cx) / bw, 2)))
                let p = (j * cw + i) * 3
                let (L, A, B) = lab(crop.data[p], crop.data[p + 1], crop.data[p + 2])
                let li = Int(min(max(L / 100 * Float(bins.l), 0), Float(bins.l - 1)))
                let ai = Int(min(max((A + 40) / 80 * Float(bins.a), 0), Float(bins.a - 1)))
                let bi = Int(min(max((B + 40) / 80 * Float(bins.b), 0), Float(bins.b - 1)))
                hist[(li * bins.a + ai) * bins.b + bi] += wt
            }
        }
        let total = hist.reduce(0, +)
        return total > 0 ? hist.map { Float($0 / total) } : nil
    }

    /// cv2.cvtColor(float RGB, COLOR_RGB2Lab): sRGB's curve undone, D65 XYZ, then Lab (L 0...100).
    static func lab(_ r: Float, _ g: Float, _ b: Float) -> (Float, Float, Float) {
        func lin(_ v: Float) -> Float { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        let R = lin(r), G = lin(g), B = lin(b)
        let X = (0.412453 * R + 0.357580 * G + 0.180423 * B) / 0.950456
        let Y = 0.212671 * R + 0.715160 * G + 0.072169 * B
        let Z = (0.019334 * R + 0.119193 * G + 0.950227 * B) / 1.088754
        func f(_ t: Float) -> Float { t > 0.008856 ? cbrt(t) : 7.787 * t + 16 / 116 }
        let L = Y > 0.008856 ? 116 * cbrt(Y) - 16 : 903.3 * Y
        return (L, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z)))
    }

    /// How alike two clothes descriptions are (Bhattacharyya): 1 = the same colours, 0 = none shared.
    public static func like(_ a: [Float]?, _ b: [Float]?) -> Float? {
        guard let a, let b, a.count == b.count else { return nil }
        var s: Float = 0
        for i in a.indices { s += (max(0, a[i]) * max(0, b[i])).squareRoot() }
        return s
    }
}
