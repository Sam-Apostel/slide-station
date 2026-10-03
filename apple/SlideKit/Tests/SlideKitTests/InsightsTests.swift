import XCTest
@testable import SlideKit

/// Suggestions and decisions as insights.py / places.py / server.py make them (tests/test_insights.py
/// and tests/test_places.py check the same rules there).
final class InsightsTests: XCTestCase {
    let venice = Slide.Place(name: "Venice", lat: 45.43713, lon: 12.33265, country: "Italy", admin: "Veneto", id: 3164603)
    let rome = Slide.Place(name: "Rome", lat: 41.89193, lon: 12.51133, country: "Italy")

    func slide(_ id: String = "g1") -> Slide { Slide(id: id, scans: ["a"], params: Params()) }

    func tag(_ v: String, _ c: Double = 0.5, _ s: Insights.State = .suggested) -> JSONValue {
        Insights.Suggestion(value: v, confidence: c, source: "m", state: s).json
    }

    func testMergeKeepsDecisions() {
        let old: JSONValue = .object(["key": .string("k0"), "tags": .array([tag("beach", 0.3, .dismissed), tag("sea", 0.3, .accepted), tag("snow", 0.2, .suggested)]),
                                      "date": .object(["value": .string("1978")]), "faces": .int(2)])
        let new: [String: JSONValue] = ["key": .string("k1"), "tags": .array([tag("beach", 0.6), tag("boat", 0.4), tag("dog", 0.3)])]
        let out = Insights.merge(old, new, ownTags: ["dog"], ownCaption: "", ownPlace: nil)
        let tags = (out["tags"]?.list ?? []).compactMap(Insights.Suggestion.init)
        XCTAssertEqual(tags.map(\.value), ["beach", "boat", "dog", "sea"])
        XCTAssertEqual(tags.map(\.state), [.dismissed, .suggested, .accepted, .accepted], "decisions stand; a tag it has counts as accepted")
        XCTAssertEqual(tags[0].confidence, 0.6, "confidence refreshed")
        XCTAssertEqual(out["key"], .string("k1"))
        XCTAssertEqual(out["date"], old["date"], "a kind not computed is kept")
        XCTAssertEqual(out["faces"], .int(2), "what only the desktop knows is kept")
    }

    func testCaptionNeverOverTheSlidesOwn() {
        let cap = Insights.Suggestion(value: "A beach.", confidence: 0.4, source: "c").json
        var out = Insights.merge(nil, ["key": .string("k"), "caption": cap], ownTags: [], ownCaption: "Mine", ownPlace: nil)
        XCTAssertEqual(out["caption"], .null)
        out = Insights.merge(nil, ["key": .string("k"), "caption": cap], ownTags: [], ownCaption: "", ownPlace: nil)
        XCTAssertEqual(Insights.Suggestion(out["caption"])?.value, "A beach.")
        // dismissed, then the model says the same again: still dismissed
        let dismissed = Insights.Suggestion(value: "A beach.", confidence: 0.4, source: "c", state: .dismissed).json
        out = Insights.merge(.object(["caption": dismissed]), ["key": .string("k2"), "caption": cap], ownTags: [], ownCaption: "", ownPlace: nil)
        XCTAssertEqual(Insights.Suggestion(out["caption"])?.state, .dismissed)
    }

    func testPlaceMerge() {
        let s = Insights.Suggestion.place(venice, confidence: 0.6, source: "ocr")
        var dismissed = s; dismissed.state = .dismissed
        XCTAssertEqual(Insights.mergePlace(dismissed, s, own: nil)?.state, .dismissed)
        XCTAssertEqual(Insights.mergePlace(nil, s, own: venice)?.state, .accepted, "names the slide's own place")
        XCTAssertNil(Insights.mergePlace(nil, s, own: rome), "the slide has another place: nothing new")
        var accepted = Insights.Suggestion.place(rome, confidence: 0.6, source: "ocr"); accepted.state = .accepted
        XCTAssertEqual(Insights.mergePlace(accepted, s, own: nil)?.value, "Rome, Italy", "an accepted place is never replaced")
        XCTAssertEqual(s.value, "Venice, Italy")
    }

    func testDecideTagsAndLearning() {
        var g = slide()
        g.insights = .object(["key": .string("k"), "tags": .array([tag("beach"), tag("sea"), tag("dog")])])
        XCTAssertEqual(g.decide(.tags, accept: true, value: "beach"), ["beach"])
        XCTAssertEqual(g.tags, ["beach"])
        XCTAssertEqual(g.decide(.tags, accept: false), ["sea", "dog"], "dismiss the rest")
        XCTAssertNil(g.decide(.tags, accept: true), "nothing open")
        // removing an accepted tag dismisses it; typing a suggested one accepts it
        g.insights = .object(["key": .string("k"), "tags": .array([tag("beach", 0.5, .accepted), tag("boat")])])
        XCTAssertEqual(g.setTags(["Boat ", "boat"]), ["beach"])
        XCTAssertEqual(g.tags, ["boat"])
        XCTAssertEqual(g.tagSuggestions.map(\.state), [.dismissed, .accepted])

        let root = FileManager.default.temporaryDirectory.appendingPathComponent("learn-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let learning = InsightsLearning(root: root)
        learning.record(["beach", "beach", "beach"], accepted: false)
        learning.record(["sea"], accepted: true)
        XCTAssertEqual(learning.factors()["beach"], 4)
        XCTAssertEqual(learning.factors()["sea"], 1)
    }

    func testDecideCaptionAndPlace() {
        var g = slide()
        g.insights = .object(["key": .string("k"), "tags": .array([]),
                              "caption": Insights.Suggestion(value: "Two boats.", confidence: 0.5, source: "c").json,
                              "place": Insights.Suggestion.place(venice, confidence: 0.6, source: "ocr").json])
        XCTAssertNotNil(g.decide(.caption, accept: true, text: "Two  boats  in Venice."))
        XCTAssertEqual(g.caption, "Two boats in Venice.")
        XCTAssertEqual(g.suggestion(.caption)?.state, .accepted)
        XCTAssertNotNil(g.decide(.place, accept: true))
        XCTAssertEqual(g.place, venice)
        // choosing another place settles an open suggestion as dismissed
        var h = slide()
        h.insights = .object(["place": Insights.Suggestion.place(venice, confidence: 0.6, source: "ocr").json])
        h.setPlace(rome)
        XCTAssertEqual(h.suggestion(.place)?.state, .dismissed)
    }

    func testTypedCaptionDropsTheOpenSuggestion() {
        var g = slide()
        let key: (Slide) -> String? = { Insights.key($0, models: ["c"], captionModel: "c") }
        g.insights = .object(["key": .string(key(g)!), "caption": Insights.Suggestion(value: "x", confidence: 0.5, source: "c").json])
        g.setCaption("Mine", freshKey: key)
        XCTAssertEqual(g.insights?["caption"], .null)
        XCTAssertFalse(Insights.needsAnalysis(g, models: ["c"], captionModel: "c"), "no new look just for that")
        g.setCaption("", freshKey: key)
        XCTAssertTrue(Insights.needsAnalysis(g, models: ["c"], captionModel: "c"), "cleared: a caption is suggested again")
    }

    func testSuggestBetween() {
        var t = Tray(id: "t", name: "T")
        t.groups = (0..<6).map { slide("s\($0)") }
        t.groups[0].place = venice; t.groups[3].place = venice; t.groups[5].place = rome
        XCTAssertEqual(Insights.suggestBetween(&t), 2)
        XCTAssertEqual(t.groups[1].suggestion(.place)?.place, venice)
        XCTAssertEqual(t.groups[1].suggestion(.place)?.text, "slides 1 and 4")
        XCTAssertNil(t.groups[4].suggestion(.place), "between different places")
        XCTAssertEqual(Insights.suggestBetween(&t), 0, "already suggested")
        t.groups[3].place = rome   // the neighbours changed: withdrawn
        Insights.suggestBetween(&t)
        XCTAssertNil(t.groups[1].suggestion(.place))
    }

    func testRoundTripThroughTheLibrary() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("slidekit-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent("sessions/t1"), withIntermediateDirectories: true)
        let file = root.appendingPathComponent("sessions/t1/session.json")
        let desktop = """
        {"id": "t1", "name": "Venice", "album": "Venice", "date": "", "created": 1.0, "log": [], "defaults": {"strength": 0.6, "brightness": 0.0, "contrast": 0.0, "warmth": 0.0, "tint": 0.0, "saturation": 0.0, "trim": true}, "scans": {}, "groups": [{"id": "g1", "scans": ["a"], "excluded": [], "rotation": 0, "rot_reason": "",
          "params": {}, "reviewed": false, "skip": false, "immich": null, "tags": ["sea"],
          "place": {"name": "Venice", "lat": 45.43713, "lon": 12.33265, "country": "Italy", "admin": "Veneto", "id": 3164603},
          "insights": {"key": "abc", "tags": [{"value": "sea", "confidence": 0.41, "source": "clip-vit-b32", "state": "accepted"}],
                       "caption": null, "date": {"value": "1978", "source": "stock"}, "place": null, "text": [{"text": "VENEZIA", "confidence": 0.9}]}}]}
        """
        try Data(desktop.utf8).write(to: file)
        let library = try Library(root: root)
        var t = try await library.load("t1")
        XCTAssertEqual(t.groups[0].place, venice)
        XCTAssertEqual(t.groups[0].readText, ["VENEZIA"])
        let before = try JSONValue.parse(Data(contentsOf: file))
        t = try await library.update("t1") { $0.groups[0].reviewed = true }
        let after = try JSONValue.parse(Data(contentsOf: file))
        for k in ["insights", "place", "tags"] { XCTAssertEqual(after["groups"]?.list?[0][k], before["groups"]?.list?[0][k], k) }
        _ = try await library.update("t1") { $0.groups[0].setTags(["sea", "boat"]); $0.groups[0].setPlace(self.rome) }
        let edited = try JSONValue.parse(Data(contentsOf: file))["groups"]?.list?[0]
        XCTAssertEqual(edited?["tags"], .array([.string("sea"), .string("boat")]))
        XCTAssertEqual(edited?["place"]?["name"], .string("Rome"))
        XCTAssertEqual(edited?["insights"]?["date"], before["groups"]?.list?[0]["insights"]?["date"], "the desktop's date guess kept")
    }
}
