import CoreGraphics
import Foundation
import ImageIO
@testable import SlideInsights
import SlideKit
import XCTest

/// The rules of places.place_from_text with Apple's tagger and a made-up Apple Maps; Vision's
/// labels as the desktop's tags. `SLIDEINSIGHTS_REAL=<folder of photos>` runs the real models too.
final class SlideInsightsTests: XCTestCase {
    let cities: [String: Slide.Place] = [
        "venice": Slide.Place(name: "Venice", lat: 45.4384, lon: 12.3185, country: "Italy"),
        "venezia": Slide.Place(name: "Venice", lat: 45.4384, lon: 12.3185, country: "Italy"),
        "paris": Slide.Place(name: "Paris", lat: 48.8568, lon: 2.3511, country: "France"),
        "zermatt": Slide.Place(name: "Zermatt", lat: 46.0195, lon: 7.7467, country: "Switzerland"),
        "nice": Slide.Place(name: "Nice", lat: 43.6989, lon: 7.2723, country: "France"),
        "roma": Slide.Place(name: "Rome", lat: 41.8919, lon: 12.5113, country: "Italy"),
    ]

    func lines(_ texts: String...) -> [SignPlaces.Line] { texts.map { SignPlaces.Line(text: $0, confidence: 0.95) } }

    func place(_ l: [SignPlaces.Line]) async -> Insights.Suggestion? {
        let cities = cities
        return await SignPlaces.place(from: l) { cities[SignPlaces.fold($0)] }
    }

    func testFold() {
        XCTAssertEqual(SignPlaces.fold("Bienvenue à  SAINT-TROPEZ!"), "bienvenue a saint tropez")
        XCTAssertEqual(SignPlaces.fold("Grüß aus München"), "gruss aus munchen")
    }

    func testACueCountsMost() async {
        let s = await place(lines("WELCOME TO VENICE"))
        XCTAssertEqual(s?.place?.name, "Venice")
        XCTAssertEqual(s?.value, "Venice, Italy")
        XCTAssertEqual(s?.text, "WELCOME TO VENICE")
        XCTAssertEqual(s!.confidence, 0.855, accuracy: 0.001)
        // the cue on one line, the name on the next; another name for it after a cue
        let next = await place(lines("BENVENUTI A", "VENEZIA"))
        XCTAssertEqual(next?.place?.name, "Venice")
    }

    func testNamesWithoutACue() async {
        let z = await place(lines("ZERMATT"))
        XCTAssertEqual(z?.place?.name, "Zermatt", "a line that is just a town's name")
        let nice = await place(lines("NICE"))
        XCTAssertNil(nice, "a sign word that is also a town: only after a cue")
        let cue = await place(lines("Souvenir de Nice"))
        XCTAssertEqual(cue?.place?.name, "Nice")
        let street = await place(lines("VIA ROMA 12"))
        XCTAssertNil(street, "a street named after a city")
        let road = await place(lines("PARIS ROAD"))
        XCTAssertNil(road)
        let other = await place(lines("VENEZIA"))
        XCTAssertNil(other, "Apple Maps knows it as Venice: without a cue that's too loose")
    }

    func testLowConfidenceReadingIsNoSuggestion() async {
        let s = await place([SignPlaces.Line(text: "ZERMATT", confidence: 0.4)])
        XCTAssertNil(s, "0.6 x 0.4 is under 0.3")
    }

    func testTagsFromVisionLabels() {
        let ranked = SceneTags.rank(labels: ["sailboat": 0.7, "ocean": 0.45, "lake": 0.2, "people": 0.68], faces: [])
        XCTAssertEqual(ranked.prefix(2).map(\.0), ["boat", "sea"])
        let tags = SceneTags.suggest(ranked)
        XCTAssertEqual(tags.map(\.value), ["boat", "sea"], "lake is under the threshold")
        XCTAssertEqual(SceneTags.suggest(ranked, factors: ["boat": 4]).map(\.value), ["sea"], "dismissed often: needs more")
        let group = SceneTags.rank(labels: ["people": 0.8], faces: (0..<4).map { CGRect(x: Double($0) * 0.2, y: 0.3, width: 0.08, height: 0.1) })
        XCTAssertEqual(group.first?.0, "family group")
        let portrait = SceneTags.rank(labels: [:], faces: [CGRect(x: 0.3, y: 0.2, width: 0.3, height: 0.4)])
        XCTAssertEqual(portrait.first?.0, "portrait")
        XCTAssertTrue(SceneTags.modelID.hasPrefix("apple-vision-tags-"))
    }

    func testCaptionTidy() {
        XCTAssertEqual(Captions.tidy("  \"a man  on a boat.\" "), "A man on a boat.")
        XCTAssertLessThanOrEqual(Captions.tidy(String(repeating: "word ", count: 80)).count, 200)
    }

    /// The real models on real photos (`SLIDEINSIGHTS_REAL=<folder>`): prints what each suggests.
    func testRealPhotos() async throws {
        guard let dir = ProcessInfo.processInfo.environment["SLIDEINSIGHTS_REAL"] else { throw XCTSkip("SLIDEINSIGHTS_REAL not set") }
        let files = try FileManager.default.contentsOfDirectory(atPath: dir).filter { $0.lowercased().hasSuffix("jpg") || $0.lowercased().hasSuffix("jpeg") }.sorted()
        let a = Analyzer(tags: true, captions: true, places: true)
        print("models:", a.models, "captions:", Captions.availability)
        for f in files.prefix(12) {
            let src = try XCTUnwrap(CGImageSourceCreateWithURL(URL(fileURLWithPath: dir).appendingPathComponent(f) as CFURL, nil))
            let img = try XCTUnwrap(CGImageSourceCreateThumbnailAtIndex(src, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                                                                kCGImageSourceThumbnailMaxPixelSize: 1024,
                                                                                kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary))
            let out = try await a.analyse(Slide(scans: ["a"], params: Params()), image: img, factors: [:])
            let tags = (out["tags"]?.list ?? []).compactMap(Insights.Suggestion.init).map { "\($0.value) \($0.confidence)" }
            print("==", f, "| tags:", tags, "| caption:", Insights.Suggestion(out["caption"])?.value ?? "-",
                  "| place:", Insights.Suggestion(out["place"])?.value ?? "-", "| text:", (out["text"]?.list ?? []).compactMap { $0["text"]?.text })
            XCTAssertNotNil(out["key"])
        }
    }
}
