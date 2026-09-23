import Foundation

/// Shared geometry and value normalization for the custom faders and knobs.
public enum ProRangeMath {
    public static func clamp(_ value: Double, min lower: Double, max upper: Double) -> Double {
        Swift.min(Swift.max(lower, upper), Swift.max(lower, value.isFinite ? value : lower))
    }
    public static func normalized(_ value: Double, min lower: Double, max upper: Double, step: Double) -> Double {
        let increment = step.isFinite && step > 0 ? step : 1
        guard value.isFinite else { return lower }
        let rounded = (lower + ((value - lower) / increment).rounded(.toNearestOrAwayFromZero) * increment)
        return clamp((rounded * 100_000_000).rounded() / 100_000_000, min: lower, max: upper)
    }
    public static func progress(_ value: Double, min lower: Double, max upper: Double) -> Double {
        guard upper > lower else { return 0 }
        return clamp((value - lower) / (upper - lower), min: 0, max: 1)
    }
    public static func value(at x: Double, width: Double, inset: Double, min lower: Double, max upper: Double) -> Double {
        lower + clamp((x - inset) / Swift.max(1, width - inset * 2), min: 0, max: 1) * Swift.max(0, upper - lower)
    }
}
