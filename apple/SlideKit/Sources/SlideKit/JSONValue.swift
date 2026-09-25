import Foundation

/// A JSON document as written, ints and floats kept apart — what the Python app reads and hashes.
///
/// `session.json` is shared with the Python app, which knows fields this app doesn't (insights,
/// places, Immich stacks, mirror…). `Library` keeps the file as a `JSONValue` next to the typed
/// `Tray` and writes back through `merge`, so a tray saved here keeps everything it didn't touch.
public enum JSONValue: Equatable, Hashable, Sendable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    /// Every number in here as a float: the Python app's develop settings are floats throughout,
    /// and `JSONEncoder` writes 0.0 as `0`.
    public var floats: JSONValue {
        switch self {
        case .int(let i): return .double(Double(i))
        case .array(let a): return .array(a.map(\.floats))
        case .object(let o): return .object(o.mapValues(\.floats))
        default: return self
        }
    }

    // MARK: merge

    /// What to write back: `new` (the typed tray, encoded), keeping `raw` (the file as read) wherever
    /// `new` still equals `base` (the typed tray as read, encoded). Keys only the file has are kept;
    /// keys the typed tray dropped go. Arrays of objects with an "id" (slides) merge per element.
    public static func merge(raw: JSONValue, base: JSONValue, new: JSONValue) -> JSONValue {
        if new == base { return raw }
        switch (raw, base, new) {
        case (.object(let r), .object(let b), .object(let n)):
            var out = r.filter { b[$0.key] == nil }   // fields this app doesn't know
            for (k, v) in n {
                if let rk = r[k], let bk = b[k] { out[k] = merge(raw: rk, base: bk, new: v) } else { out[k] = v }
            }
            return .object(out)
        case (.array(let r), .array(let b), .array(let n)) where n.allSatisfy({ $0["id"] != nil }):
            func byID(_ a: [JSONValue]) -> [JSONValue: JSONValue] {
                Dictionary(a.compactMap { v in v["id"].map { ($0, v) } }, uniquingKeysWith: { a, _ in a })
            }
            let rs = byID(r), bs = byID(b)
            return .array(n.map { v in
                guard let id = v["id"], let rv = rs[id], let bv = bs[id] else { return v }
                return merge(raw: rv, base: bv, new: v)
            })
        default:
            return new
        }
    }

    // MARK: reading

    public static func parse(_ data: Data) throws -> JSONValue {
        var p = Parser(bytes: [UInt8](data))
        p.skipSpace()
        let v = try p.value()
        p.skipSpace()
        guard p.i == p.bytes.count else { throw p.fail("trailing characters") }
        return v
    }

    /// A Codable value as JSON (through `JSONEncoder`, so the same field names and nulls).
    public static func encode<T: Encodable>(_ value: T) throws -> JSONValue {
        try parse(JSONEncoder().encode(value))
    }

    private struct Parser {
        let bytes: [UInt8]
        var i = 0

        func fail(_ why: String) -> Error {
            DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "JSON: \(why) at byte \(i)"))
        }

        mutating func skipSpace() {
            while i < bytes.count, [0x20, 0x09, 0x0A, 0x0D].contains(bytes[i]) { i += 1 }
        }

        mutating func literal(_ s: String, _ v: JSONValue) throws -> JSONValue {
            let b = Array(s.utf8)
            guard i + b.count <= bytes.count, Array(bytes[i..<i + b.count]) == b else { throw fail("unexpected token") }
            i += b.count
            return v
        }

        mutating func value() throws -> JSONValue {
            guard i < bytes.count else { throw fail("unexpected end") }
            switch bytes[i] {
            case UInt8(ascii: "{"):
                i += 1
                var o: [String: JSONValue] = [:]
                skipSpace()
                if i < bytes.count, bytes[i] == UInt8(ascii: "}") { i += 1; return .object(o) }
                while true {
                    skipSpace()
                    guard i < bytes.count, bytes[i] == UInt8(ascii: "\"") else { throw fail("expected a key") }
                    let k = try string()
                    skipSpace()
                    guard i < bytes.count, bytes[i] == UInt8(ascii: ":") else { throw fail("expected :") }
                    i += 1
                    skipSpace()
                    o[k] = try value()
                    skipSpace()
                    guard i < bytes.count else { throw fail("unexpected end") }
                    if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
                    if bytes[i] == UInt8(ascii: "}") { i += 1; return .object(o) }
                    throw fail("expected , or }")
                }
            case UInt8(ascii: "["):
                i += 1
                var a: [JSONValue] = []
                skipSpace()
                if i < bytes.count, bytes[i] == UInt8(ascii: "]") { i += 1; return .array(a) }
                while true {
                    skipSpace()
                    a.append(try value())
                    skipSpace()
                    guard i < bytes.count else { throw fail("unexpected end") }
                    if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
                    if bytes[i] == UInt8(ascii: "]") { i += 1; return .array(a) }
                    throw fail("expected , or ]")
                }
            case UInt8(ascii: "\""): return .string(try string())
            case UInt8(ascii: "t"): return try literal("true", .bool(true))
            case UInt8(ascii: "f"): return try literal("false", .bool(false))
            case UInt8(ascii: "n"): return try literal("null", .null)
            case UInt8(ascii: "N"): return try literal("NaN", .double(.nan))   // Python writes these
            case UInt8(ascii: "I"): return try literal("Infinity", .double(.infinity))
            default: return try number()
            }
        }

        mutating func number() throws -> JSONValue {
            let start = i
            var float = false
            if i < bytes.count, bytes[i] == UInt8(ascii: "-") {
                i += 1
                if i < bytes.count, bytes[i] == UInt8(ascii: "I") { _ = try literal("Infinity", .null); return .double(-.infinity) }
            }
            while i < bytes.count {
                let c = bytes[i]
                if (0x30...0x39).contains(c) || c == UInt8(ascii: "+") || c == UInt8(ascii: "-") { i += 1 }
                else if c == UInt8(ascii: ".") || c == UInt8(ascii: "e") || c == UInt8(ascii: "E") { float = true; i += 1 }
                else { break }
            }
            let s = String(decoding: bytes[start..<i], as: UTF8.self)
            if !float, let n = Int(s) { return .int(n) }
            guard let d = Double(s) else { throw fail("bad number \(s)") }
            return .double(d)
        }

        mutating func hex4() throws -> UInt32 {
            guard i + 4 <= bytes.count, let v = UInt32(String(decoding: bytes[i..<i + 4], as: UTF8.self), radix: 16) else { throw fail("bad \\u escape") }
            i += 4
            return v
        }

        mutating func string() throws -> String {
            i += 1   // opening quote
            var out = [UInt8]()
            while true {
                guard i < bytes.count else { throw fail("unterminated string") }
                let c = bytes[i]
                i += 1
                if c == UInt8(ascii: "\"") { break }
                guard c == UInt8(ascii: "\\") else { out.append(c); continue }
                guard i < bytes.count else { throw fail("unterminated escape") }
                let e = bytes[i]
                i += 1
                switch e {
                case UInt8(ascii: "n"): out.append(0x0A)
                case UInt8(ascii: "t"): out.append(0x09)
                case UInt8(ascii: "r"): out.append(0x0D)
                case UInt8(ascii: "b"): out.append(0x08)
                case UInt8(ascii: "f"): out.append(0x0C)
                case UInt8(ascii: "u"):
                    var u = try hex4()
                    if (0xD800...0xDBFF).contains(u), i + 6 <= bytes.count, bytes[i] == UInt8(ascii: "\\"), bytes[i + 1] == UInt8(ascii: "u") {
                        i += 2
                        let lo = try hex4()
                        u = 0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00)
                    }
                    out.append(contentsOf: Array(String(Character(Unicode.Scalar(u) ?? "\u{FFFD}")).utf8))
                default: out.append(e)   // \" \\ \/
                }
            }
            return String(decoding: out, as: UTF8.self)
        }
    }

    // MARK: writing

    /// The file form: two-space indented, keys sorted, floats always with a point or exponent (so
    /// Python reads 0.0 back as a float, not the int 0).
    public func serialized() -> Data {
        var s = ""
        write(&s, pretty: true, python: false, indent: 0)
        s += "\n"
        return Data(s.utf8)
    }

    /// Byte for byte what Python's `json.dumps(self, sort_keys=sortKeys)` gives — for keys that
    /// both apps hash (`store.render_key`, `store.meta_key`).
    public func pythonDumps(sortKeys: Bool = true) -> String {
        var s = ""
        write(&s, pretty: false, python: true, indent: 0, sortKeys: sortKeys)
        return s
    }

    private func write(_ s: inout String, pretty: Bool, python: Bool, indent: Int, sortKeys: Bool = true) {
        let pad = pretty ? String(repeating: "  ", count: indent + 1) : ""
        let close = pretty ? String(repeating: "  ", count: indent) : ""
        let comma = pretty ? ",\n" : ", "
        let colon = pretty || python ? ": " : ":"
        switch self {
        case .null: s += "null"
        case .bool(let b): s += b ? "true" : "false"
        case .int(let n): s += String(n)
        case .double(let d): s += JSONValue.float(d)
        case .string(let t): JSONValue.quote(t, into: &s, ascii: python)
        case .array(let a):
            if a.isEmpty { s += "[]"; return }
            s += pretty ? "[\n" : "["
            for (n, v) in a.enumerated() {
                if n > 0 { s += comma }
                s += pad
                v.write(&s, pretty: pretty, python: python, indent: indent + 1, sortKeys: sortKeys)
            }
            s += pretty ? "\n\(close)]" : "]"
        case .object(let o):
            if o.isEmpty { s += "{}"; return }
            s += pretty ? "{\n" : "{"
            // unsorted only for Python's insertion order, which a Swift dictionary doesn't keep —
            // every hashed key this app makes is sorted or has no objects
            let keys = sortKeys ? o.keys.sorted(by: JSONValue.pythonOrder) : Array(o.keys)
            for (n, k) in keys.enumerated() {
                if n > 0 { s += comma }
                s += pad
                JSONValue.quote(k, into: &s, ascii: python)
                s += colon
                o[k]!.write(&s, pretty: pretty, python: python, indent: indent + 1, sortKeys: sortKeys)
            }
            s += pretty ? "\n\(close)}" : "}"
        }
    }

    /// Python sorts str keys by code point; Swift's `<` on String compares grapheme clusters.
    static func pythonOrder(_ a: String, _ b: String) -> Bool { a.unicodeScalars.lexicographicallyPrecedes(b.unicodeScalars) }

    /// Python's `float.__repr__`: the shortest string that reads back the same, which is also
    /// Swift's `description` — apart from the spellings of the specials.
    static func float(_ d: Double) -> String {
        if d.isNaN { return "NaN" }
        if d.isInfinite { return d > 0 ? "Infinity" : "-Infinity" }
        return d.description
    }

    static func quote(_ t: String, into s: inout String, ascii: Bool) {
        s += "\""
        for u in t.unicodeScalars {
            switch u {
            case "\"": s += "\\\""
            case "\\": s += "\\\\"
            case "\n": s += "\\n"
            case "\r": s += "\\r"
            case "\t": s += "\\t"
            case "\u{08}": s += "\\b"
            case "\u{0C}": s += "\\f"
            default:
                if u.value < 0x20 || (ascii && u.value > 0x7E) {
                    for unit in String(u).utf16 { s += String(format: "\\u%04x", unit) }
                } else {
                    s.unicodeScalars.append(u)
                }
            }
        }
        s += "\""
    }
}
