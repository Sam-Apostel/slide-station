import CryptoKit
import Foundation
import SlideKit

/// Thresholds, as `people.py` has them.
public enum FaceRules {
    public static let samePerson: Float = 0.363   // SFace's recommended cosine-similarity threshold for "same identity"
    static let minScore: Float = 0.7              // the detector confidence a face needs
    static let minSize: Float = 0.03              // and its size, as a share of the picture's width
    static let match: Float = 0.8                 // a face found again (after turning) keeps its id above this
    public static let near = 3                    // slides either side a name spreads to
    static let looksLike: Float = 0.2             // there, a face this like theirs…
    static let sameClothes: Float = 0.8           // …in clothes this alike is them
    static let clothesOnly: Float = 0.9           // next to a face marked by hand: the clothes alone, this alike
}

extension Slide {
    /// What a slide's faces were found on: its blended scans, turned upright (`people.face_key`).
    public var faceKey: String {
        var k: [JSONValue] = [.array(activeScans.map { .string($0) }), .int(rotation)]
        if mirror { k.append(.string("mirror")) }
        let s = JSONValue.array(k).pythonDumps(sortKeys: false)
        return Insecure.SHA1.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined().prefix(12).description
    }
}

/// One face as stored in a tray's faces.json.
public struct StoredFace: Sendable, Equatable {
    public var id: String
    /// (x, y, w, h), 0...1 of the upright slide.
    public var box: [Double]
    public var score: Double
    /// Unit 128-d feature; nil for a face marked by hand where none was found (the back of a head).
    public var emb: [Float]?
    public var clothes: [Float]?
    public var age: Double?
    public var manual: Bool

    public var tray: String { String(id.split(separator: "/").first ?? "") }
    public var slide: String { let p = id.split(separator: "/"); return p.count > 1 ? String(p[1]) : "" }
}

/// float16 little-endian, base64: how `people._pack` keeps features (numpy float16 `tobytes`).
/// Written by hand: Swift's Float16 doesn't exist on Intel Macs.
enum Half {
    static func pack(_ v: [Float]) -> String {
        var bytes = [UInt8](); bytes.reserveCapacity(v.count * 2)
        for f in v { let h = toHalf(f); bytes.append(UInt8(h & 0xff)); bytes.append(UInt8(h >> 8)) }
        return Data(bytes).base64EncodedString()
    }

    static func unpack(_ s: String) -> [Float]? {
        guard let d = Data(base64Encoded: s), d.count % 2 == 0 else { return nil }
        return stride(from: 0, to: d.count, by: 2).map { fromHalf(UInt16(d[d.startIndex + $0]) | UInt16(d[d.startIndex + $0 + 1]) << 8) }
    }

    /// IEEE 754 binary16, round to nearest even (as numpy).
    static func toHalf(_ f: Float) -> UInt16 {
        let x = f.bitPattern
        let sign = UInt16((x >> 16) & 0x8000)
        let exp = Int((x >> 23) & 0xff), mant = x & 0x7fffff
        if exp == 0xff { return sign | 0x7c00 | (mant != 0 ? 0x200 : 0) }
        var e = exp - 127 + 15
        if e >= 0x1f { return sign | 0x7c00 }
        if e <= 0 {
            if e < -10 { return sign }
            let m = mant | 0x800000
            let shift = UInt32(14 - e)
            var h = m >> shift
            let rem = m & ((1 << shift) - 1), half = UInt32(1) << (shift - 1)
            if rem > half || (rem == half && (h & 1) == 1) { h += 1 }
            return sign | UInt16(h)
        }
        var m = mant >> 13
        let rem = mant & 0x1fff
        if rem > 0x1000 || (rem == 0x1000 && (m & 1) == 1) {
            m += 1
            if m == 0x400 { m = 0; e += 1; if e >= 0x1f { return sign | 0x7c00 } }
        }
        return sign | UInt16(e << 10) | UInt16(m)
    }

    static func fromHalf(_ h: UInt16) -> Float {
        let sign = UInt32(h & 0x8000) << 16
        let exp = Int((h >> 10) & 0x1f), mant = UInt32(h & 0x3ff)
        if exp == 0 {
            if mant == 0 { return Float(bitPattern: sign) }
            var e = -1, m = mant
            repeat { e += 1; m <<= 1 } while m & 0x400 == 0
            return Float(bitPattern: sign | UInt32(127 - 15 - e) << 23 | (m & 0x3ff) << 13)
        }
        if exp == 0x1f { return Float(bitPattern: sign | 0x7f800000 | mant << 13) }
        return Float(bitPattern: sign | UInt32(exp - 15 + 127) << 23 | mant << 13)
    }
}

/// The faces of every tray (`sessions/<id>/faces.json`) and people.json, in one library: the files
/// the desktop app reads and writes too. Unknown fields (ages, which model aged them) are kept.
public final class FaceFiles: @unchecked Sendable {
    public let root: URL
    let lock = NSRecursiveLock()
    private var cache: [String: (Date, [String: StoredFace])] = [:]

    public init(root: URL) { self.root = root }

    func facesURL(_ tray: String) -> URL { root.appendingPathComponent("sessions/\(tray)/faces.json") }
    var peopleURL: URL { root.appendingPathComponent("people.json") }
    public var modelsDir: URL { root.appendingPathComponent("models", isDirectory: true) }

    func read(_ url: URL) -> [String: JSONValue] {
        guard let d = try? Data(contentsOf: url), case .object(let o)? = try? JSONValue.parse(d) else { return [:] }
        return o
    }

    func write(_ url: URL, _ o: [String: JSONValue]) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONValue.object(o).serialized().write(to: url, options: .atomic)
    }

    /// A tray's faces.json as stored: {slide id: {"key", "rot", "mirror", "faces": [...], ...}}.
    public func entries(_ tray: String) -> [String: JSONValue] { lock.withLock { read(facesURL(tray)) } }

    /// One slide's faces as stored.
    public func faces(tray: String, slide: String) -> [StoredFace] {
        entries(tray)[slide]?["faces"]?.list?.compactMap(Self.face) ?? []
    }

    /// Reload, apply, save (like `update_faces`).
    func updateFaces(_ tray: String, _ fn: (inout [String: JSONValue]) throws -> Void) throws {
        try lock.withLock {
            var d = read(facesURL(tray))
            try fn(&d)
            try write(facesURL(tray), d)
            cache[tray] = nil
        }
    }

    static func face(_ v: JSONValue) -> StoredFace? {
        guard case .object(let o) = v, case .string(let id)? = o["id"], case .array(let b)? = o["box"], b.count == 4 else { return nil }
        let box = b.compactMap(\.number)
        guard box.count == 4 else { return nil }
        var emb: [Float]?
        if case .string(let s)? = o["emb"] { emb = Half.unpack(s).map(unit) }
        var clothes: [Float]?
        if case .string(let s)? = o["clothes"], var c = Half.unpack(s) {
            let t = c.reduce(0, +); if t > 0 { c = c.map { $0 / t } }; clothes = c
        }
        var manual = false
        if case .bool(let m)? = o["manual"] { manual = m }
        return StoredFace(id: id, box: box, score: o["score"]?.number ?? 0, emb: emb, clothes: clothes, age: o["age"]?.number, manual: manual)
    }

    /// Every face of the library by id (`people.all_faces`); trays re-read only when their file changed.
    public func allFaces() -> [String: StoredFace] {
        lock.withLock {
            var out: [String: StoredFace] = [:]
            let sessions = root.appendingPathComponent("sessions")
            let trays = (try? FileManager.default.contentsOfDirectory(atPath: sessions.path)) ?? []
            for tray in trays.sorted() {
                let url = facesURL(tray)
                guard let mt = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate else { continue }
                if let hit = cache[tray], hit.0 == mt { out.merge(hit.1) { a, _ in a }; continue }
                var faces: [String: StoredFace] = [:]
                for (_, e) in read(url) {
                    guard case .array(let list)? = e["faces"] else { continue }
                    for f in list.compactMap(Self.face) { faces[f.id] = f }
                }
                cache[tray] = (mt, faces)
                out.merge(faces) { a, _ in a }
            }
            return out
        }
    }
}

extension JSONValue {
    var number: Double? {
        switch self {
        case .int(let i): Double(i)
        case .double(let d): d
        default: nil
        }
    }
    var text: String? { if case .string(let s) = self { return s }; return nil }
    var list: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    var dict: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
    var flag: Bool { if case .bool(let b) = self { return b }; return false }
}

/// Python's round(x, n) on what's stored (boxes, scores).
func rounded(_ v: Double, _ places: Int) -> Double {
    let p = pow(10, Double(places))
    return (v * p).rounded(.toNearestOrEven) / p
}
