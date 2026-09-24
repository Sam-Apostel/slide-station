import Foundation

/// Develop settings for one slide. Same keys, ranges and defaults as `imaging.Params` in the
/// Python app, so a tray's JSON means the same thing on both sides.
public struct Params: Codable, Equatable, Hashable, Sendable {
    public var strength: Double = 0.6      // auto fade restoration 0..1
    public var brightness: Double = 0       // -1..1
    public var contrast: Double = 0         // -1..1
    public var warmth: Double = 0           // -1..1
    public var tint: Double = 0             // -1..1 (+ = magenta)
    public var saturation: Double = 0       // -1..1
    public var trim: Bool = true            // crop dark slide-mount edges
    /// Point curves per channel ("rgb", "r", "g", "b"), points in 0..1; a missing channel is straight.
    public var curves: [String: [[Double]]] = [:]
    public var angle: Double = 0            // straighten, degrees clockwise (-15..15)
    public var crop: [Double]?              // [left, top, right, bottom] in 0..1 of the straightened frame
    public var dust: Double = 0             // dust & scratch repair 0..1 (0 = off)
    /// Local adjustments (graduated / radial / brush), applied in order after the rest; each slide's own.
    public var local: [LocalAdjustment] = []

    public init() {}

    public static let learnedKeys: [WritableKeyPath<Params, Double>] = [\.strength, \.brightness, \.contrast, \.warmth, \.tint, \.saturation]

    enum CodingKeys: String, CodingKey { case strength, brightness, contrast, warmth, tint, saturation, trim, curves, angle, crop, dust, local }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func num(_ k: CodingKeys, _ d: Double) -> Double { (try? c.decode(Double.self, forKey: k)) ?? d }
        strength = num(.strength, 0.6); brightness = num(.brightness, 0); contrast = num(.contrast, 0)
        warmth = num(.warmth, 0); tint = num(.tint, 0); saturation = num(.saturation, 0); angle = num(.angle, 0)
        trim = (try? c.decode(Bool.self, forKey: .trim)) ?? true
        curves = Curves.clean((try? c.decode([String: [[Double]]].self, forKey: .curves)) ?? [:])
        crop = Params.cleanCrop(try? c.decode([Double].self, forKey: .crop))
        dust = min(1, max(0, num(.dust, 0)))   // trays from before dust repair have none
        local = LocalAdjustment.clean((try? c.decode([LocalAdjustment].self, forKey: .local)) ?? [])   // none in older trays
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(strength, forKey: .strength); try c.encode(brightness, forKey: .brightness)
        try c.encode(contrast, forKey: .contrast); try c.encode(warmth, forKey: .warmth)
        try c.encode(tint, forKey: .tint); try c.encode(saturation, forKey: .saturation)
        try c.encode(trim, forKey: .trim); try c.encode(curves, forKey: .curves)
        try c.encode(angle, forKey: .angle); try c.encode(crop, forKey: .crop); try c.encode(dust, forKey: .dust)
        try c.encode(local, forKey: .local)
    }

    /// `[l, t, r, b]` in 0..1, at least 5 % each way; the whole frame (or junk) means no crop.
    public static func cleanCrop(_ v: [Double]?) -> [Double]? {
        guard let v, v.count == 4 else { return nil }
        let c = v.map { min(1, max(0, $0)) }
        let (l, t, r, b) = (c[0], c[1], c[2], c[3])
        if r - l < 0.05 || b - t < 0.05 || (l <= 0.001 && t <= 0.001 && r >= 0.999 && b >= 0.999) { return nil }
        return c.map { ($0 * 10_000).rounded() / 10_000 }
    }
}
