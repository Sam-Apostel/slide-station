import CryptoKit
import Foundation

/// One scan (a JPEG from the card) as recorded in a tray.
public struct ScanRecord: Codable, Equatable, Sendable {
    public var file: String
    public var source: String
    public var sourceRoot: String
    public var removable: Bool
    public var size: Int
    public var sha1: String
    public var taken: String          // EXIF "YYYY:MM:DD HH:MM:SS" (the scanner's clock: order, not date)
    public var sourceDeleted: Bool = false

    enum CodingKeys: String, CodingKey {
        case file, source, removable, size, sha1, taken
        case sourceRoot = "source_root", sourceDeleted = "source_deleted"
    }
}

/// What was uploaded: Immich's asset id plus the keys it was rendered with.
public struct UploadRecord: Codable, Equatable, Sendable {
    public var assetId: String
    public var key: String
    public var meta: String?
    enum CodingKeys: String, CodingKey { case key, meta, assetId = "asset_id" }
}

/// A slide: one or more scans of the same picture (a bracket) that become one photo.
/// Mirrors a "group" in the Python app's `session.json`.
public struct Slide: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var scans: [String]
    public var excluded: [String] = []
    public var autoExcluded: [String: String]?   // scan id -> "blurry" | "clipped"
    public var rotation: Int = 0                  // clockwise, 0/90/180/270
    public var rotReason: String = ""             // "faces" | "sky" | "manual" | ""
    public var params: Params
    public var paramsSource: String?
    public var reviewed: Bool = false             // "developed" in the UI
    public var skip: Bool = false
    public var immich: UploadRecord?
    public var date: String?
    public var caption: String?
    public var locked: String?
    /// Features of the blended, undeveloped slide, for learning (Python: `g["feat"]`).
    public var feat: [Double]?
    /// Undo / redo of the slide's look (Python: `g["history"]`).
    public var history: History?
    /// The slide mount found on its scans (Python: `g["mount"]`); see `currentMount`.
    public var mount: MountEdge?

    enum CodingKeys: String, CodingKey {
        case id, scans, excluded, rotation, params, reviewed, skip, immich, date, caption, locked, feat, history, mount
        case autoExcluded = "auto_excluded", rotReason = "rot_reason", paramsSource = "params_source"
    }

    public init(id: String = Slide.newID(), scans: [String], params: Params) {
        self.id = id; self.scans = scans; self.params = params
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        scans = try c.decode([String].self, forKey: .scans)
        excluded = (try? c.decode([String].self, forKey: .excluded)) ?? []
        autoExcluded = try? c.decode([String: String].self, forKey: .autoExcluded)
        rotation = (try? c.decode(Int.self, forKey: .rotation)) ?? 0
        rotReason = (try? c.decode(String.self, forKey: .rotReason)) ?? ""
        params = (try? c.decode(Params.self, forKey: .params)) ?? Params()
        paramsSource = try? c.decode(String.self, forKey: .paramsSource)
        reviewed = (try? c.decode(Bool.self, forKey: .reviewed)) ?? false
        skip = (try? c.decode(Bool.self, forKey: .skip)) ?? false
        immich = try? c.decode(UploadRecord.self, forKey: .immich)
        date = try? c.decode(String.self, forKey: .date)
        caption = try? c.decode(String.self, forKey: .caption)
        locked = try? c.decode(String.self, forKey: .locked)
        feat = try? c.decode([Double].self, forKey: .feat)
        history = try? c.decode(History.self, forKey: .history)
        mount = try? c.decode(MountEdge.self, forKey: .mount)
    }

    /// Every key, nulls included, like the Python app writes a group (it reads some with `g["immich"]`).
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(scans, forKey: .scans); try c.encode(excluded, forKey: .excluded)
        try c.encodeIfPresent(autoExcluded, forKey: .autoExcluded)
        try c.encode(rotation, forKey: .rotation); try c.encode(rotReason, forKey: .rotReason)
        try c.encode(params, forKey: .params); try c.encodeIfPresent(paramsSource, forKey: .paramsSource)
        try c.encode(reviewed, forKey: .reviewed); try c.encode(skip, forKey: .skip)
        try c.encode(immich, forKey: .immich)
        try c.encodeIfPresent(date, forKey: .date); try c.encodeIfPresent(caption, forKey: .caption); try c.encodeIfPresent(locked, forKey: .locked)
        try c.encodeIfPresent(feat, forKey: .feat); try c.encodeIfPresent(history, forKey: .history)
        try c.encodeIfPresent(mount, forKey: .mount)
    }

    // MARK: undo

    public static let historyMax = 60
    public static let coalesce: TimeInterval = 1.5   // edits to the same setting closer than this are one step

    public var canUndo: Bool { !(history?.undo.isEmpty ?? true) }
    public var canRedo: Bool { !(history?.redo.isEmpty ?? true) }

    var snapshot: History.Snapshot {
        History.Snapshot(params: params, rotation: rotation, rotReason: rotReason, paramsSource: paramsSource ?? "", what: nil, t: 0)
    }

    /// Push the look before an edit onto the undo stack (a slider drag is one step). Python: `_remember`.
    public mutating func remember(_ what: String, now: Date = Date()) {
        var h = history ?? History()
        let t = now.timeIntervalSince1970
        if let last = h.undo.last, last.what == what, t - last.t < Slide.coalesce {
            h.undo[h.undo.count - 1].t = t   // same drag: keep the state from before it started
        } else {
            var s = snapshot; s.what = what; s.t = t
            h.undo = Array((h.undo + [s]).suffix(Slide.historyMax))
        }
        h.redo = []
        history = h
    }

    /// Step back (`undo: true`) or forward; returns what was undone or redone.
    @discardableResult
    public mutating func step(undo: Bool) -> String? {
        var h = history ?? History()
        guard let snap = undo ? h.undo.popLast() : h.redo.popLast() else { return nil }
        var mine = snapshot; mine.what = snap.what
        if undo { h.redo.append(mine) } else { h.undo.append(mine) }
        params = snap.params; rotation = snap.rotation; rotReason = snap.rotReason
        paramsSource = snap.paramsSource.isEmpty ? nil : snap.paramsSource
        history = h
        return snap.what
    }
}

public struct History: Codable, Equatable, Sendable {
    public var undo: [Snapshot] = []
    public var redo: [Snapshot] = []
    public struct Snapshot: Codable, Equatable, Sendable {
        public var params: Params
        public var rotation: Int
        public var rotReason: String
        public var paramsSource: String
        public var what: String?
        public var t: Double
        enum CodingKeys: String, CodingKey { case params, rotation, what, t, rotReason = "rot_reason", paramsSource = "params_source" }
        public init(params: Params, rotation: Int, rotReason: String, paramsSource: String, what: String?, t: Double) {
            self.params = params; self.rotation = rotation; self.rotReason = rotReason; self.paramsSource = paramsSource; self.what = what; self.t = t
        }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            params = (try? c.decode(Params.self, forKey: .params)) ?? Params()
            rotation = (try? c.decode(Int.self, forKey: .rotation)) ?? 0
            rotReason = (try? c.decode(String.self, forKey: .rotReason)) ?? ""
            paramsSource = (try? c.decode(String.self, forKey: .paramsSource)) ?? ""
            what = try? c.decode(String.self, forKey: .what)
            t = (try? c.decode(Double.self, forKey: .t)) ?? 0
        }
    }
    public init() {}
}

extension Slide {

    public static func newID() -> String { String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(8)).lowercased() }

    /// Scans that go into the photo; never empty.
    public var activeScans: [String] {
        let s = scans.filter { !excluded.contains($0) }
        return s.isEmpty ? Array(scans.prefix(1)) : s
    }

    /// Changes whenever the rendered pixels would change (Python: `store.render_key`).
    public var renderKey: String {
        var parts: [String] = [activeScans.joined(separator: ","), String(rotation)]
        let p = params
        parts += [p.strength, p.brightness, p.contrast, p.warmth, p.tint, p.saturation].map { String(format: "%.4f", $0) }
        parts.append(p.trim ? "trim" : "notrim")
        if !p.curves.isEmpty { parts.append(p.curves.sorted { $0.key < $1.key }.map { "\($0.key):\($0.value)" }.joined(separator: ";")) }
        if p.angle != 0 { parts.append(String(format: "a%.3f", p.angle)) }
        if let c = p.crop { parts.append("c\(c)") }
        if p.dust != 0 { parts.append(String(format: "d%.3f", p.dust)) }   // only when on: older keys stay
        if !p.local.isEmpty {   // likewise only when there are some
            let enc = JSONEncoder()
            enc.outputFormatting = .sortedKeys
            parts.append("l" + String(decoding: (try? enc.encode(p.local)) ?? Data(), as: UTF8.self))
        }
        return shortHash(parts.joined(separator: "|"))
    }
}

public enum SlideStatus: String, Sendable { case new, reviewed, changed, uploaded, skipped }

/// A tray (or box) of slides that becomes one Immich album. Python: a session.
public struct Tray: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var album: String
    public var date: String
    public var created: Double
    public var defaults: Params
    public var scans: [String: ScanRecord]
    public var groups: [Slide]
    public var log: [[LogValue]] = []
    /// The tray date every uploaded slide carries; differs from `date` → all need new EXIF.
    public var dateKey: String?
    public var immichAlbumId: String?
    /// Immich assets of slides that were merged away or skipped after upload, to trash next upload.
    public var orphanAssets: [String]?
    public var cardCleaned: Bool?

    enum CodingKeys: String, CodingKey {
        case id, name, album, date, created, defaults, scans, groups, log
        case dateKey = "date_key", immichAlbumId = "immich_album_id", orphanAssets = "orphan_assets", cardCleaned = "card_cleaned"
    }

    public init(id: String, name: String, album: String? = nil, date: String = "") {
        self.id = id
        self.name = name.isEmpty ? "Untitled tray" : name
        self.album = album ?? self.name
        self.date = date
        created = Date().timeIntervalSince1970
        defaults = Params()
        scans = [:]
        groups = []
    }

    public func index(of slideID: String) -> Int? { groups.firstIndex { $0.id == slideID } }

    public mutating func appendLog(_ message: String) {
        log.append([.number(Date().timeIntervalSince1970), .text(message)])
        if log.count > 200 { log.removeFirst(log.count - 200) }
    }

    // MARK: status

    public func statuses() -> [SlideStatus] {
        let dates = SlideDates.estimate(self)
        return zip(groups, dates).map { g, d in Tray.status(g, meta: Tray.metaKey(g, date: d)) }
    }

    public static func metaKey(_ g: Slide, date: SlideDate) -> String { shortHash("\(date.value)|\(g.caption ?? "")") }

    public static func status(_ g: Slide, meta: String? = nil) -> SlideStatus {
        if g.skip { return .skipped }
        if let im = g.immich {
            if g.locked != nil { return .uploaded }
            if im.key == g.renderKey && (meta == nil || (im.meta ?? meta) == meta) { return .uploaded }
            return .changed
        }
        return g.reviewed ? .reviewed : .new
    }

    public struct Summary: Sendable, Equatable {
        public var slides = 0, developed = 0, uploaded = 0, skipped = 0, pendingUpload = 0, readyUpload = 0
    }

    public func summary() -> Summary {
        let st = statuses()
        var s = Summary()
        s.slides = groups.count
        for (g, x) in zip(groups, st) {
            if g.reviewed || x == .uploaded || x == .skipped { s.developed += 1 }
            if x == .uploaded { s.uploaded += 1 }
            if x == .skipped { s.skipped += 1 }
            if [.new, .reviewed, .changed].contains(x) { s.pendingUpload += 1 }
            if g.reviewed && (x == .reviewed || x == .changed) { s.readyUpload += 1 }
        }
        return s
    }
}

/// `log` entries are `[timestamp, message]` pairs — mixed JSON arrays.
public enum LogValue: Codable, Equatable, Sendable {
    case number(Double), text(String)
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let d = try? c.decode(Double.self) { self = .number(d) } else { self = .text((try? c.decode(String.self)) ?? "") }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self { case .number(let d): try c.encode(d); case .text(let s): try c.encode(s) }
    }
}

func shortHash(_ s: String) -> String {
    Insecure.SHA1.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined().prefix(12).description
}
