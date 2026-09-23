import Foundation

/// Learns colour corrections from developed slides and suggests them for new ones — `learning.py`
/// in Swift, reading and writing the same `learning.json` in the library. Every developed slide is
/// one example: 14 features of the blended, undeveloped scan plus the settings it was developed
/// with. New slides get distance-weighted k-nearest-neighbour settings.
public enum Learning {
    public static let featureCount = 14
    public static let minExamples = 5
    public static let k = 7
    public static let maxExamples = 20_000
    public static let maxDistance: Float = 3.0
    public static let keys: [(String, WritableKeyPath<Params, Double>)] = [
        ("strength", \.strength), ("brightness", \.brightness), ("contrast", \.contrast),
        ("warmth", \.warmth), ("tint", \.tint), ("saturation", \.saturation),
    ]

    /// Fading, cast and contrast of a blended slide (Python: `learning.features`).
    public static func features(_ rgb: RGBImage, scans: Int = 1) -> [Double] {
        let a = rgb.resized(width: 160, height: 107)
        var ch: [[Float]] = [[], [], []], lum: [Float] = []
        for i in 0..<a.pixelCount {
            let r = a.data[i * 3], g = a.data[i * 3 + 1], b = a.data[i * 3 + 2]
            ch[0].append(r); ch[1].append(g); ch[2].append(b); lum.append((r + g + b) / 3)
        }
        let sorted = ch.map { $0.sorted() }
        var out: [Double] = []
        var med = [Double](repeating: 0, count: 3)
        for q in [1.0, 50, 99] {   // numpy reshape(-1) order: percentile-major, channel-minor
            for c in 0..<3 {
                let v = Double(percentile(sorted: sorted[c], q))
                out.append(v)
                if q == 50 { med[c] = v }
            }
        }
        let ls = lum.sorted()
        let lo = Double(percentile(sorted: ls, 5)), mid = Double(percentile(sorted: ls, 50)), hi = Double(percentile(sorted: ls, 95))
        let eps = 1e-3
        out += [mid, hi - lo, log((med[0] + eps) / (med[1] + eps)), log((med[2] + eps) / (med[1] + eps)), Double(min(scans, 5)) / 5]
        return out
    }

    public struct Example: Codable, Equatable, Sendable {
        public var key: String
        public var f: [Double]
        public var p: [String: Double]
        public var trim: Bool
        public var t: Double
    }

    public struct Suggestion: Equatable, Sendable {
        public var values: [String: Double]
        public var trim: Bool
        public var neighbours: Int
        public func apply(to params: Params) -> Params {
            var p = params
            for (name, kp) in Learning.keys { if let v = values[name] { p[keyPath: kp] = v } }
            p.trim = trim
            return p
        }
    }

    /// Examples + standardisation, persisted as `learning.json` (Python's format).
    public final class Model: @unchecked Sendable {
        public let url: URL
        public private(set) var examples: [Example] = []
        private var X: [[Float]]?, mu: [Float] = [], sd: [Float] = []
        private let lock = NSLock()

        public init(url: URL) {
            self.url = url
            struct File: Decodable { var examples: [Example] }
            if let d = try? Data(contentsOf: url), let f = try? JSONDecoder().decode(File.self, from: d) { examples = f.examples }
            fit()
        }

        public var ready: Bool { lock.withLock { X != nil } }

        private func save() {
            struct File: Encodable { var version = 1; var examples: [Example] }
            try? JSONEncoder().encode(File(examples: Array(examples.suffix(Learning.maxExamples)))).write(to: url, options: .atomic)
        }

        private func fit() {
            guard examples.count >= Learning.minExamples else { X = nil; return }
            let rows = examples.map { $0.f.map(Float.init) }
            let n = Float(rows.count)
            mu = (0..<Learning.featureCount).map { j in rows.reduce(0) { $0 + $1[j] } / n }
            sd = (0..<Learning.featureCount).map { j in (rows.reduce(0) { $0 + ($1[j] - mu[j]) * ($1[j] - mu[j]) } / n).squareRoot() + 1e-3 }
            X = rows.map { r in (0..<Learning.featureCount).map { (r[$0] - mu[$0]) / sd[$0] } }
        }

        /// Record (or update) the settings a slide was developed with.
        public func remember(key: String, features f: [Double], params: Params) {
            guard f.count == Learning.featureCount else { return }
            lock.withLock {
                let e = Example(key: key, f: f.map { ($0 * 100_000).rounded() / 100_000 },
                                p: Dictionary(uniqueKeysWithValues: Learning.keys.map { ($0.0, params[keyPath: $0.1]) }),
                                trim: params.trim, t: Date().timeIntervalSince1970)
                if let i = examples.firstIndex(where: { $0.key == key }) { examples[i] = e } else { examples.append(e) }
                save(); fit()
            }
        }

        public func forget(key: String) {
            lock.withLock {
                let n = examples.count
                examples.removeAll { $0.key == key }
                if examples.count != n { save(); fit() }
            }
        }

        public func reset() { lock.withLock { examples = []; save(); fit() } }

        /// Settings for a new slide, or nil when too few examples or none close enough.
        public func suggest(_ f: [Double]) -> Suggestion? {
            lock.withLock {
                guard let X, f.count == Learning.featureCount else { return nil }
                let q = (0..<Learning.featureCount).map { (Float(f[$0]) - mu[$0]) / sd[$0] }
                let d = X.map { row in (zip(row, q).reduce(Float(0)) { $0 + ($1.0 - $1.1) * ($1.0 - $1.1) } / Float(Learning.featureCount)).squareRoot() }
                let idx = d.indices.sorted { d[$0] < d[$1] }.prefix(Learning.k).filter { d[$0] <= Learning.maxDistance }
                guard !idx.isEmpty else { return nil }
                var w = idx.map { 1 / (d[$0] + 0.25) }
                let s = w.reduce(0, +); w = w.map { $0 / s }
                var values: [String: Double] = [:]
                let defaults = Params()
                for (name, kp) in Learning.keys {
                    let v = zip(idx, w).reduce(Float(0)) { $0 + Float(examples[$1.0].p[name] ?? defaults[keyPath: kp]) * $1.1 }
                    values[name] = (Double(v) * 1000).rounded() / 1000
                }
                let trim = zip(idx, w).reduce(Float(0)) { $0 + (examples[$1.0].trim ? 1 : 0) * $1.1 } >= 0.5
                return Suggestion(values: values, trim: trim, neighbours: idx.count)
            }
        }
    }
}
