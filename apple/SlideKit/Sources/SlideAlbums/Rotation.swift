import Foundation

/// The widget's way through the followed albums: every photo once, in a shuffled order that stays
/// the same between timeline reloads (so it really gets round to all of them), then a new order.
/// The place it got to is kept in the App Group's defaults.
public struct Rotation {
    let defaults: UserDefaults
    public init(defaults: UserDefaults = SharedStore.defaults) { self.defaults = defaults }

    /// The next `count` photos (fewer when there are fewer), advancing the place.
    public mutating func next(_ count: Int, of photos: [AlbumPhoto]) -> [AlbumPhoto] {
        guard !photos.isEmpty, count > 0 else { return [] }
        var seed = UInt64(bitPattern: Int64(defaults.integer(forKey: "rotationSeed")))
        var cursor = defaults.integer(forKey: "rotationCursor")
        if seed == 0 { seed = UInt64.random(in: 1...UInt64(Int64.max)) }
        var out: [AlbumPhoto] = []
        var order = Self.order(photos, seed: seed)
        while out.count < min(count, photos.count) {
            if cursor >= order.count {   // round done: a new order, starting over
                seed = seed &* 6364136223846793005 &+ 1442695040888963407
                if seed == 0 { seed = 1 }
                order = Self.order(photos, seed: seed)
                cursor = 0
            }
            out.append(order[cursor])
            cursor += 1
        }
        defaults.set(Int(Int64(bitPattern: seed)), forKey: "rotationSeed")
        defaults.set(cursor, forKey: "rotationCursor")
        return out
    }

    /// The photos in the order `seed` gives them; independent of the order they arrive in, so a
    /// refetched album keeps its place (new photos land somewhere in the round).
    static func order(_ photos: [AlbumPhoto], seed: UInt64) -> [AlbumPhoto] {
        var unique: [String: AlbumPhoto] = [:]
        for p in photos { unique[p.id] = unique[p.id] ?? p }
        var rng = SplitMix64(seed: seed)
        var sorted = unique.values.sorted { $0.id < $1.id }
        sorted.shuffle(using: &rng)
        return sorted
    }
}

struct SplitMix64: RandomNumberGenerator {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
}
