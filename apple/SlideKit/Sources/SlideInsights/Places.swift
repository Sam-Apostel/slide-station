import CoreGraphics
import Foundation
import MapKit
import NaturalLanguage
import SlideKit
import Vision

/// Where a slide was taken, read from the photo: the text on its signs (Vision's text recogniser),
/// the place a sign names ("WELCOME TO VENICE"), looked up in Apple Maps. Instead of the desktop's
/// PaddleOCR and its downloaded GeoNames list (places.py); the same rules for what counts as a
/// place name: a name after a cue counts most; without one it must be a place name to Apple's
/// language tagger or a line on its own, not a common sign word, nor part of a street or a business
/// name, and Apple Maps must know a city called exactly that.
public enum SignPlaces {
    public static let ocrID = "apple-vision-text"
    public static let minConfidence = 0.3   // places.MIN_CONFIDENCE

    public struct Line: Sendable, Equatable { public var text: String; public var confidence: Double }

    /// The text in an upright picture, read the way a sign reads (no language correction: names).
    public static func read(_ image: CGImage) throws -> [Line] {
        let r = VNRecognizeTextRequest()
        r.recognitionLevel = .accurate
        r.usesLanguageCorrection = false
        r.minimumTextHeight = 0.015
        onCPUInSimulator([r])
        try VNImageRequestHandler(cgImage: image).perform([r])
        return (r.results ?? []).compactMap { $0.topCandidates(1).first }
            .map { Line(text: $0.string, confidence: Double($0.confidence)) }
            .filter { $0.text.contains(where: \.isLetter) }
    }

    // words that introduce a place on a sign, folded (places.CUES)
    static let cues = ["welcome to", "greetings from", "bienvenue a", "bienvenue au", "bienvenue en", "willkommen in",
                       "benvenuti a", "benvenuti in", "benvenuto a", "bienvenidos a", "bienvenido a", "welkom in", "welkom te",
                       "bem vindo a", "bem vindos a", "vitajte v", "witamy w", "velkommen til", "valkommen till", "gruss aus",
                       "grusse aus", "souvenir de", "ricordo di", "recuerdo de", "greetings of"]
    // sign and film-box words that are also the name of a town somewhere: only after a cue (places.COMMON)
    static let common = Set("""
        bar nice split best deal mobile reading bath most sale open exit stop taxi bus hotel park post police bank
        museum center centre city beach station opera parking central university college victoria orange paradise
        hope independence union liberty concord hollywood harmony industry commerce enterprise progress victory
        welcome eden mission bay port porto santa san saint st east west north south la le de del el los las
        hall market gate bridge church castle lake mountain river valley view avenue street road place plaza
        cafe restaurant bakery pizza shop store tourist information entrance ausgang eingang sortie entree
        uscita entrata salida entrada zimmer frei rooms camping pension tabac apotheke pharmacie farmacia office
        marina airport metro plage playa coca cola castello riviera kodak agfa fuji ilford ektachrome kodachrome
        agfachrome sakura polaroid esso shell texaco total mobil garage auto sport grand royal palace imperial
        metropol metropole europa bellevue belvedere panorama miramar splendid excelsior savoy ritz astoria
        continental majestic ocean harbour harbor pier lido
        """.split(whereSeparator: \.isWhitespace).map(String.init))
    // a name right after these is a street, a hotel ("Via Roma"); before these too ("London Road")
    static let notAfter = Set("""
        via viale corso piazza piazzale largo vicolo rue avenue boulevard bd place quai chemin allee
        calle avenida plaza paseo carrer rua strasse str gasse platz weg straat laan plein hotel albergo pension
        gasthof gasthaus restaurant ristorante trattoria pizzeria cafe caffe bar brasserie hostal hostel pensione
        """.split(whereSeparator: \.isWhitespace).map(String.init))
    static let notBefore = Set("""
        road street st avenue ave lane way square station airlines airline airways air express
        match hotel restaurant cafe bar strasse str gasse platz weg straat laan plein boulevard bd club fc
        bank insurance
        """.split(whereSeparator: \.isWhitespace).map(String.init))

    /// Search form of a name (places.fold): accents off, lower case, anything but letters and digits a space.
    public static func fold(_ s: String) -> String {
        let t = s.replacingOccurrences(of: "ß", with: "ss").replacingOccurrences(of: "ø", with: "o").replacingOccurrences(of: "Ø", with: "o")
            .replacingOccurrences(of: "ł", with: "l").replacingOccurrences(of: "Ł", with: "l")
            .replacingOccurrences(of: "đ", with: "d").replacingOccurrences(of: "Đ", with: "d")
            .folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX")).lowercased()
        let mapped = t.unicodeScalars.map { ("a"..."z").contains($0) || ("0"..."9").contains($0) ? Character($0) : " " }
        return String(mapped).split(separator: " ").joined(separator: " ")
    }

    /// A name worth looking up: the words as read, how sure it is before the lookup.
    public struct Candidate: Sendable, Equatable {
        public var name: String     // as on the sign, cased for the lookup ("Venice")
        public var base: Double     // 0.9 after a cue, else 0.6 / 0.45 (places.place_from_text)
        public var cue: Bool
        public var text: String     // the line it was read in
    }

    /// The names in the text worth looking up, likeliest first (at most `limit`): every run of 1-3
    /// words after a cue; without one, a place name to Apple's language tagger or a short line of
    /// its own (≥ 4 letters, not a common sign word, not next to a street or business word, not an
    /// organisation or a person to the tagger).
    public static func candidates(_ lines: [Line], limit: Int = 4) -> [Candidate] {
        var texts = lines.map { ($0.text, $0.confidence) }
        // a cue on one line and the name on the next ("WELCOME TO" / "VENICE"): read together too
        texts += zip(texts, texts.dropFirst()).map { ("\($0.0) \($1.0)", min($0.1, $1.1)) }
        var out: [(Candidate, Double)] = []
        func add(_ words: [String], _ base: Double, cue: Bool, _ text: String, _ conf: Double) {
            let name = words.map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
            guard !out.contains(where: { fold($0.0.name) == fold(name) && $0.0.base >= base }) else { return }
            out.removeAll { fold($0.0.name) == fold(name) }
            out.append((Candidate(name: name, base: base, cue: cue, text: text), base * conf))
        }
        for (text, conf) in texts {
            let words = fold(text).split(separator: " ").map(String.init)
            guard !words.isEmpty else { continue }
            // after a cue: the next 1-3 words
            for c in cues {
                let cw = c.split(separator: " ").map(String.init)
                guard words.count > cw.count else { continue }
                for i in 0...(words.count - cw.count - 1) where Array(words[i..<(i + cw.count)]) == cw {
                    let rest = Array(words[(i + cw.count)...])
                    for n in stride(from: min(3, rest.count), through: 1, by: -1) { add(Array(rest.prefix(n)), 0.9, cue: true, text, conf) }
                }
            }
            // without a cue: what the tagger calls a place, or a short line that is just a name
            let tagged = places(in: text)
            let lone = words.count <= 3 ? [words] : []
            for span in tagged + lone {
                let key = span.joined(separator: " ")
                guard key.replacingOccurrences(of: " ", with: "").count >= 4, !common.contains(key), Int(key) == nil else { continue }
                if let i = indexOf(span, in: words) {
                    if i > 0, notAfter.contains(words[i - 1]) { continue }
                    if i + span.count < words.count, notBefore.contains(words[i + span.count]) { continue }
                }
                if !tagged.contains(span), named(text).contains(key) { continue }   // a company or a person
                add(span, key.count >= 6 ? 0.6 : 0.45, cue: false, text, conf)
            }
        }
        return out.sorted { $0.1 > $1.1 }.prefix(limit).map(\.0)
    }

    static func indexOf(_ span: [String], in words: [String]) -> Int? {
        guard span.count <= words.count else { return nil }
        return (0...(words.count - span.count)).first { Array(words[$0..<($0 + span.count)]) == span }
    }

    /// Signs are often in capitals, which the tagger reads as acronyms: title case first.
    static func titled(_ s: String) -> String {
        s.uppercased() == s ? s.lowercased().split(separator: " ").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ") : s
    }

    static func tagged(_ text: String) -> [(String, NLTag)] {
        let s = titled(text)
        let t = NLTagger(tagSchemes: [.nameType])
        t.string = s
        var out: [(String, NLTag)] = []
        t.enumerateTags(in: s.startIndex..<s.endIndex, unit: .word, scheme: .nameType, options: [.omitWhitespace, .omitPunctuation, .joinNames]) { tag, r in
            if let tag, [.placeName, .organizationName, .personalName].contains(tag) { out.append((String(s[r]), tag)) }
            return true
        }
        return out
    }

    /// The place names in a line, as folded words (at most 3 each).
    static func places(in text: String) -> [[String]] {
        tagged(text).filter { $0.1 == .placeName }.map { fold($0.0).split(separator: " ").map(String.init) }.filter { (1...3).contains($0.count) }
    }

    /// Organisations and people in a line, folded.
    static func named(_ text: String) -> Set<String> { Set(tagged(text).filter { $0.1 != .placeName }.map { fold($0.0) }) }

    /// The best place the text names, as a suggestion (places.place_from_text with Apple Maps for
    /// the gazetteer). `lookup` answers a city called that (tests replace it).
    public static func place(from lines: [Line], lookup: (String) async -> Slide.Place?) async -> Insights.Suggestion? {
        var best: Insights.Suggestion?
        for c in candidates(lines) {
            guard let p = await lookup(c.name) else { continue }
            // Apple Maps knows it by another name ("Venezia" → Venice): only after a cue
            if !c.cue && fold(p.name) != fold(c.name) { continue }
            let ocr = lines.first { c.text.contains($0.text) }?.confidence ?? 1
            let conf = c.base * ocr
            if conf >= minConfidence, conf > (best?.confidence ?? 0) {
                best = .place(p, confidence: conf, source: ocrID, text: c.text)
            }
        }
        return best
    }
}

/// Cities by name from Apple Maps, remembered (an answer, or that there is none) so a tray's signs
/// cost one lookup each: Apple's geocoder allows about one a second.
public actor CityLookup {
    public static let shared = CityLookup()
    private var known: [String: Slide.Place?] = [:]
    private let file: URL?

    public init(file: URL? = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.appendingPathComponent("city-lookups.json")) {
        self.file = file
        if let file, let d = try? Data(contentsOf: file), let o = try? JSONDecoder().decode([String: Slide.Place?].self, from: d) { known = o }
    }

    /// A city called exactly `name` (Apple Maps' best match, when that is a city, not a street or a
    /// shop), or nil.
    public func city(_ name: String) async -> Slide.Place? {
        let key = SignPlaces.fold(name)
        if let hit = known[key] { return hit }
        var found: Slide.Place?
        var failed = false
        if #available(iOS 26, macOS 26, *) {
            for q in [name, name.replacingOccurrences(of: "-", with: " ")].uniqued() {
                guard let r = MKGeocodingRequest(addressString: q) else { continue }
                do {
                    guard let item = try await r.mapItems.first, let city = item.addressRepresentations?.cityName,
                          SignPlaces.fold(item.name ?? "") == SignPlaces.fold(city) else { continue }
                    let ctx = item.addressRepresentations?.cityWithContext(.full) ?? ""
                    let admin = ctx.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.dropFirst().first { $0 != item.addressRepresentations?.regionName }
                    found = Slide.Place(name: city, lat: item.location.coordinate.latitude, lon: item.location.coordinate.longitude,
                                        country: item.addressRepresentations?.regionName ?? "", admin: admin)
                    break
                } catch {
                    // no match is an answer; offline or throttled is not: ask again another time
                    if (error as? MKError)?.code != .placemarkNotFound { failed = true }
                }
            }
        } else { failed = true }
        if !failed || found != nil {
            known[key] = found
            if let file, let d = try? JSONEncoder().encode(known) { try? d.write(to: file, options: .atomic) }
        }
        return found
    }
}

extension Array where Element: Hashable {
    func uniqued() -> [Element] { var seen = Set<Element>(); return filter { seen.insert($0).inserted } }
}
