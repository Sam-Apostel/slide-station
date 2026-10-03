import Foundation

/// Suggestions about what is on a slide, never applied silently (Python: insights.py). Per slide,
/// `g["insights"]` holds them as the desktop app writes them:
///
///     {"key": ..., "tags": [{"value": "beach", "confidence": 0.41, "source": ..., "state": "suggested"}],
///      "caption": null | {...}, "place": null | {..., "place": {name, lat, lon, country}}, "date": ..., "stock": ...}
///
/// `state` is suggested, accepted (it became the slide's own) or dismissed (it never comes back for
/// that slide, and counts against the label). `key` names what the suggestions were computed from;
/// a slide whose key is stale is looked at again, keeping every decision made. This app computes
/// them with Apple's own models (Vision, Foundation Models), so its key names those: a library
/// shared with the desktop is looked at again by whichever app finds the other's key, decisions kept.
public enum Insights {
    public enum Kind: String, Sendable, CaseIterable { case tags, caption, date, place, stock }
    public enum State: String, Sendable { case suggested, accepted, dismissed }

    /// One suggestion as stored. `value` is how it reads (for a place: "Venice, Italy").
    public struct Suggestion: Equatable, Sendable, Identifiable {
        public var value: String
        public var confidence: Double
        public var source: String
        public var state: State
        public var place: Slide.Place?
        /// Why: the text it was read from ("WELCOME TO VENICE"), the slides around it.
        public var text: String?
        public var id: String { value }

        public init(value: String, confidence: Double, source: String, state: State = .suggested, place: Slide.Place? = nil, text: String? = nil) {
            self.value = value; self.confidence = (confidence * 1000).rounded() / 1000; self.source = source
            self.state = state; self.place = place; self.text = text.map { String($0.prefix(200)) }
        }

        public init?(_ v: JSONValue?) {
            guard let o = v?.dict, let value = o["value"]?.text else { return nil }
            self.value = value
            confidence = o["confidence"]?.number ?? 0
            source = o["source"]?.text ?? ""
            state = o["state"]?.text.flatMap(State.init) ?? .suggested
            place = o["place"].flatMap { try? JSONDecoder().decode(Slide.Place.self, from: $0.serialized()) }
            text = o["text"]?.text
        }

        public var json: JSONValue {
            var o: [String: JSONValue] = ["value": .string(value), "confidence": .double(confidence),
                                          "source": .string(source), "state": .string(state.rawValue)]
            if let place, let p = try? JSONValue.encode(place) { o["place"] = p }
            if let text, !text.isEmpty { o["text"] = .string(text) }
            return .object(o)
        }

        /// A place suggestion (places.suggestion).
        public static func place(_ p: Slide.Place, confidence: Double, source: String, text: String = "") -> Suggestion {
            Suggestion(value: p.label, confidence: confidence, source: source, place: p, text: text.isEmpty ? nil : text)
        }
    }

    // MARK: the key

    /// What a slide's suggestions were computed from (insights.insights_key): its blended scans, how
    /// it's turned, the models; with captions, whether it has a caption of its own (a slide with one
    /// isn't captioned; clearing it asks for a suggestion).
    public static func key(_ g: Slide, models: [String], captionModel: String? = nil) -> String {
        var k: [JSONValue] = [.array(g.activeScans.map { .string($0) }), .int(g.rotation)] + models.map { .string($0) }
        if g.mirror { k.append(.string("mirror")) }
        if let captionModel, models.contains(captionModel) { k.append(.bool(!(g.caption ?? "").isEmpty)) }
        return shortHash(JSONValue.array(k).pythonDumps(sortKeys: false))
    }

    public static func needsAnalysis(_ g: Slide, models: [String], captionModel: String? = nil) -> Bool {
        !g.skip && !models.isEmpty && g.insights?["key"]?.text != key(g, models: models, captionModel: captionModel)
    }

    // MARK: merging

    /// Fresh suggestions with the decisions already made kept (insights.merge): accepted and
    /// dismissed tags stay (confidence refreshed), a new suggestion for a tag the slide has counts
    /// as accepted; a decided caption keeps its state while the model says the same, an open one
    /// goes once the slide has its own; places as `mergePlace`. `new` has only what was computed:
    /// a kind left out keeps what was there. Keys this app doesn't know are kept.
    public static func merge(_ old: JSONValue?, _ new: [String: JSONValue], ownTags: [String], ownCaption: String, ownPlace: Slide.Place?) -> JSONValue {
        var out = old?.dict ?? [:]
        let oldTags = (old?["tags"]?.list ?? []).compactMap(Suggestion.init)
        if let fresh = new["tags"]?.list {
            var kept = Dictionary(oldTags.filter { $0.state != .suggested }.map { ($0.value, $0) }, uniquingKeysWith: { a, _ in a })
            var tags: [Suggestion] = []
            for var e in fresh.compactMap(Suggestion.init) {
                if let k = kept.removeValue(forKey: e.value) { e.state = k.state }
                else { e.state = ownTags.contains(e.value) ? .accepted : .suggested }
                tags.append(e)
            }
            tags += oldTags.filter { kept[$0.value] != nil }   // decided, the model no longer says so: kept, in order
            out["tags"] = .array(tags.map(\.json))
        } else {
            out["tags"] = old?["tags"] ?? .array([])
        }
        out["key"] = new["key"] ?? .string("")
        for k in ["caption", "date", "stock"] {
            if let v = new[k], v != .null { out[k] = v } else { out[k] = old?[k] ?? .null }
        }
        let place = mergePlace(Suggestion(old?["place"]), Suggestion(new["place"]), own: ownPlace)
        out["place"] = place?.json ?? .null
        if let text = new["text"] { out["text"] = text }
        if let cap = Suggestion(new["caption"]), let was = Suggestion(old?["caption"]), was.state != .suggested, was.value == cap.value {
            var c = cap; c.state = was.state; out["caption"] = c.json
        }
        if !ownCaption.isEmpty, Suggestion(out["caption"])?.state == .suggested { out["caption"] = .null }
        out["error"] = new["error"]
        return .object(out)
    }

    /// A fresh place suggestion with what was decided (places.merge): a decision on the same place
    /// stands, an accepted place is never replaced, a slide with a place of its own gets nothing new
    /// (or the suggestion counts as accepted when it names that place).
    public static func mergePlace(_ old: Suggestion?, _ new: Suggestion?, own: Slide.Place?) -> Suggestion? {
        guard var new else { return old }
        if let old, old.state != .suggested, old.place?.same(new.place) == true { new.state = old.state; return new }
        if let own { if own.same(new.place) { new.state = .accepted; return new }; return old }
        if let old, old.state == .accepted { return old }
        return new
    }

    // MARK: tray neighbours

    public static let traySource = "tray"
    public static let trayConfidence = 0.9

    /// A slide between two slides with the same place (no other place between) gets it suggested
    /// (places.suggest_between). Tray suggestions that no longer hold are withdrawn; a dismissed one
    /// stays dismissed; a suggestion from the photo itself (its text) stays in front. Returns how
    /// many slides got a new one.
    @discardableResult
    public static func suggestBetween(_ tray: inout Tray) -> Int {
        let placed = tray.groups.enumerated().compactMap { i, g in g.skip ? nil : g.place.map { (i, $0) } }
        var want: [Int: (Slide.Place, String)] = [:]
        for ((i, p), (j, q)) in zip(placed, placed.dropFirst()) where j > i + 1 && p.same(q) {
            for k in (i + 1)..<j { want[k] = (p, "slides \(i + 1) and \(j + 1)") }
        }
        var n = 0
        for k in tray.groups.indices {
            let g = tray.groups[k]
            let e = Suggestion(g.insights?["place"])
            guard let (p, why) = want[k], !g.skip, g.place == nil else {
                if let e, e.source == traySource, e.state == .suggested { setPlaceSuggestion(&tray.groups[k], nil) }
                continue
            }
            if let e {
                if e.place?.same(p) == true && e.state != .suggested { continue }   // decided already
                if e.state == .suggested && e.source != traySource { continue }
                if e.source == traySource && e.place?.same(p) == true { continue }
            }
            setPlaceSuggestion(&tray.groups[k], .place(p, confidence: trayConfidence, source: traySource, text: why))
            n += 1
        }
        return n
    }

    static func setPlaceSuggestion(_ g: inout Slide, _ s: Suggestion?) {
        var o = g.insights?.dict ?? ["key": .string(""), "tags": .array([])]
        o["place"] = s?.json ?? .null
        g.insights = .object(o)
    }
}

// MARK: a slide's suggestions and decisions

extension Slide {
    public var tagSuggestions: [Insights.Suggestion] { (insights?["tags"]?.list ?? []).compactMap(Insights.Suggestion.init) }
    public func suggestion(_ kind: Insights.Kind) -> Insights.Suggestion? { Insights.Suggestion(insights?[kind.rawValue]) }
    /// What the text reader read in the photo (shown with a place it suggests).
    public var readText: [String] { (insights?["text"]?.list ?? []).compactMap { $0["text"]?.text ?? $0.text } }

    private mutating func editInsights(_ f: (inout [String: JSONValue]) -> Void) {
        var o = insights?.dict ?? ["key": .string(""), "tags": .array([])]
        f(&o)
        insights = .object(o)
    }

    private mutating func editTagSuggestions(_ f: (inout Insights.Suggestion) -> Void) {
        guard insights?["tags"] != nil else { return }
        editInsights { o in o["tags"] = .array((o["tags"]?.list ?? []).compactMap(Insights.Suggestion.init).map { var e = $0; f(&e); return e.json }) }
    }

    /// A slide's own tags (server._clean_tags): trimmed, lower case, no repeats, at most 30 of 40 characters.
    public static func cleanTags(_ tags: [String]) -> [String] {
        var out: [String] = []
        for t in tags {
            let v = String(t.split(whereSeparator: \.isWhitespace).joined(separator: " ").lowercased().prefix(40))
            if !v.isEmpty && !out.contains(v) { out.append(v) }
        }
        return Array(out.prefix(30))
    }

    /// Set the slide's tags (server._set_tags): a suggested tag removed counts as dismissed, one
    /// typed in counts as accepted. Returns the tags newly dismissed (for the learning counts).
    @discardableResult
    public mutating func setTags(_ new: [String]) -> [String] {
        let tags = Slide.cleanTags(new)
        let removed = Set(self.tags ?? []).subtracting(tags)
        var dismissed: [String] = []
        editTagSuggestions { e in
            if removed.contains(e.value) && e.state == .accepted { e.state = .dismissed; dismissed.append(e.value) }
            else if tags.contains(e.value) && e.state == .suggested { e.state = .accepted }
        }
        self.tags = tags.isEmpty ? nil : tags
        return dismissed
    }

    /// Set or clear the place (server._set_place): an open place suggestion is settled by it, the
    /// same place accepted, another dismissed.
    public mutating func setPlace(_ p: Place?) {
        place = p
        if let p, var e = suggestion(.place), e.state == .suggested {
            e.state = e.place?.same(p) == true ? .accepted : .dismissed
            editInsights { $0["place"] = e.json }
        }
    }

    /// Give the slide its own caption (server._set_caption): an open caption suggestion goes, and
    /// suggestions that were up to date stay so (`freshKey`: the key with the caption, when they were).
    public mutating func setCaption(_ text: String, freshKey: (Slide) -> String?) {
        let wasFresh = freshKey(self) == insights?["key"]?.text && insights != nil
        caption = text.isEmpty ? nil : text
        guard insights != nil, !text.isEmpty else { return }
        if suggestion(.caption)?.state == .suggested { editInsights { $0["caption"] = .null } }
        if wasFresh, let k = freshKey(self) { editInsights { $0["key"] = .string(k) } }
    }

    /// Accept or dismiss the open suggestion(s) of one kind (server._decide): all its values, or
    /// `value`. Accepting makes it the slide's own (a caption as edited: `text`); a suggested caption
    /// never replaces one the slide has. Returns the tags decided (for the learning counts), or nil
    /// when nothing changed.
    @discardableResult
    public mutating func decide(_ kind: Insights.Kind, accept: Bool, value: String? = nil, text: String? = nil,
                                freshKey: (Slide) -> String? = { _ in nil }) -> [String]? {
        if kind == .tags {
            let hits = tagSuggestions.filter { (value == nil || $0.value == value) && $0.state == .suggested }.map(\.value)
            guard !hits.isEmpty else { return nil }
            var tags = self.tags ?? []
            editTagSuggestions { e in if hits.contains(e.value) { e.state = accept ? .accepted : .dismissed } }
            for h in hits {
                if accept, !tags.contains(h) { tags.append(h) }
                if !accept { tags.removeAll { $0 == h } }
            }
            self.tags = tags.isEmpty ? nil : tags
            return hits
        }
        guard var e = suggestion(kind), value == nil || e.value == value, e.state == .suggested else { return nil }
        if accept {
            switch kind {
            case .caption:
                guard (caption ?? "").isEmpty else { return nil }
                let c = String((text ?? e.value).split(whereSeparator: \.isWhitespace).joined(separator: " ").prefix(2000))
                guard !c.isEmpty else { return nil }
                e.state = .accepted
                editInsights { $0["caption"] = e.json }
                setCaption(c, freshKey: freshKey)
                return []
            case .date: date = e.value
            case .stock: stock = e.value
            case .place: place = e.place
            case .tags: break
            }
        }
        e.state = accept ? .accepted : .dismissed
        editInsights { $0[kind.rawValue] = e.json }
        return []
    }
}

// MARK: learning

/// Every accept / dismiss of a suggested tag, counted per label in the library's insights.json
/// (insights.record / threshold): a label dismissed more often than accepted needs a higher
/// confidence before it is suggested again, up to 4x. The same file as the desktop's.
public final class InsightsLearning: @unchecked Sendable {
    public let url: URL
    private let lock = NSLock()

    public init(root: URL) { url = root.appendingPathComponent("insights.json") }

    private func read() -> [String: JSONValue] {
        guard let d = try? Data(contentsOf: url), let o = (try? JSONValue.parse(d))?.dict else { return ["labels": .object([:])] }
        return o
    }

    public func record(_ labels: [String], accepted: Bool) {
        guard !labels.isEmpty else { return }
        lock.withLock {
            var d = read()
            var all = d["labels"]?.dict ?? [:]
            for l in labels {
                var c = all[l]?.dict ?? ["accepted": .int(0), "dismissed": .int(0)]
                let k = accepted ? "accepted" : "dismissed"
                c[k] = .int(Int(c[k]?.number ?? 0) + 1)
                all[l] = .object(c)
            }
            d["labels"] = .object(all)
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? JSONValue.object(d).serialized().write(to: url, options: .atomic)
        }
    }

    /// How much surer than `base` the model must be before suggesting `label`.
    public func factors() -> [String: Double] {
        let all = lock.withLock { read()["labels"]?.dict ?? [:] }
        return all.mapValues { c in
            min(4, max(1, (1 + (c["dismissed"]?.number ?? 0)) / (1 + (c["accepted"]?.number ?? 0))))
        }
    }
}
