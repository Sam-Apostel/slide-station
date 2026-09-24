import XCTest
@testable import SlideKit

/// Learning, undo, card cleanup and locked slides.
final class FeatureTests: XCTestCase {
    struct Golden: Decodable {
        var features: [Double]
        var learning_examples: [Learning.Example]
        var learning_query: [Double]
        var learning_suggestion: [String: AnyNumberOrBool]
        var learning_neighbours: Int
        var learning_curve_examples: [Learning.Example]
        var learning_curve_suggestion: [String: [[Double]]]
        var developed_crop_shape: [Int]
        var params_crop: Params
    }
    enum AnyNumberOrBool: Decodable {
        case n(Double), b(Bool)
        init(from d: Decoder) throws {
            let c = try d.singleValueContainer()
            if let b = try? c.decode(Bool.self) { self = .b(b) } else { self = .n(try c.decode(Double.self)) }
        }
    }
    lazy var golden = try! JSONDecoder().decode(Golden.self, from: Data(contentsOf: ParityTests.dir.appendingPathComponent("golden.json")))

    func tmp() throws -> URL {
        let u = FileManager.default.temporaryDirectory.appendingPathComponent("slidekit-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: u) }
        return u
    }

    // MARK: learning

    func testFeaturesMatchPython() throws {
        let f = Learning.features(try ImageFile.load(ParityTests.dir.appendingPathComponent("scene.png")), scans: 2)
        XCTAssertEqual(f.count, 14)
        for (a, b) in zip(f, golden.features) { XCTAssertEqual(a, b, accuracy: 0.01) }
    }

    func testSuggestionMatchesPython() throws {
        let url = try tmp().appendingPathComponent("learning.json")
        struct File: Encodable { var version = 1; var examples: [Learning.Example] }
        try JSONEncoder().encode(File(examples: golden.learning_examples)).write(to: url)
        let model = Learning.Model(url: url)
        XCTAssertTrue(model.ready)
        let s = try XCTUnwrap(model.suggest(golden.learning_query))
        XCTAssertEqual(s.neighbours, golden.learning_neighbours)
        for (k, v) in golden.learning_suggestion {
            switch v {
            case .n(let n): XCTAssertEqual(s.values[k]!, n, accuracy: 0.002, k)
            case .b(let b): XCTAssertEqual(s.trim, b)
            }
        }
        // remember / forget persist, and fewer than five examples means no suggestion
        let small = Learning.Model(url: try tmp().appendingPathComponent("l.json"))
        for i in 0..<4 { small.remember(key: "k\(i)", features: golden.features, params: Params()) }
        XCTAssertNil(small.suggest(golden.features))
        small.remember(key: "k4", features: golden.features, params: Params())
        XCTAssertNotNil(small.suggest(golden.features))
        small.forget(key: "k4")
        XCTAssertEqual(Learning.Model(url: small.url).examples.count, 4)
    }

    func testLearnedCurvesMatchPython() throws {
        struct File: Encodable { var version = 1; var examples: [Learning.Example] }
        // examples from before curves were learned (no "c") leave the slide's curves alone
        let oldURL = try tmp().appendingPathComponent("old.json")
        try JSONEncoder().encode(File(examples: golden.learning_examples)).write(to: oldURL)
        let old = try XCTUnwrap(Learning.Model(url: oldURL).suggest(golden.learning_query))
        XCTAssertNil(old.curves)
        var p = Params(); p.curves = ["rgb": [[0, 0.1], [1, 0.9]]]
        XCTAssertEqual(old.apply(to: p).curves, p.curves)
        // with curves: red (most of the weight) is averaged, blue (a minority) dropped
        let url = try tmp().appendingPathComponent("learning.json")
        try JSONEncoder().encode(File(examples: golden.learning_curve_examples)).write(to: url)
        let s = try XCTUnwrap(Learning.Model(url: url).suggest(golden.learning_query))
        let curves = try XCTUnwrap(s.curves)
        XCTAssertEqual(Set(curves.keys), Set(golden.learning_curve_suggestion.keys))
        for (ch, pts) in golden.learning_curve_suggestion {
            let mine = try XCTUnwrap(curves[ch])
            XCTAssertEqual(mine.count, pts.count, ch)
            for (a, b) in zip(mine, pts) {
                XCTAssertEqual(a[0], b[0], accuracy: 1e-4, ch)
                XCTAssertEqual(a[1], b[1], accuracy: 0.002, ch)
            }
        }
        XCTAssertEqual(s.apply(to: Params()).curves, curves)
        // remember stores the curves, never the framing
        var dev = Params(); dev.curves = ["g": [[0.1, 0], [0.8, 1]]]; dev.crop = [0.1, 0.1, 0.9, 0.9]
        let m = Learning.Model(url: try tmp().appendingPathComponent("r.json"))
        m.remember(key: "k", features: golden.features, params: dev)
        XCTAssertEqual(m.examples.first?.c, ["g": [[0.1, 0], [0.8, 1]]])
    }

    // MARK: undo

    func testUndoCoalescesAndSteps() {
        var g = Slide(scans: ["a"], params: Params())
        let t0 = Date(timeIntervalSince1970: 1000)
        g.remember("params:warmth", now: t0); g.params.warmth = 0.1
        g.remember("params:warmth", now: t0.addingTimeInterval(0.5)); g.params.warmth = 0.3   // same drag
        g.remember("rotation", now: t0.addingTimeInterval(5)); g.rotation = 90
        XCTAssertEqual(g.history?.undo.count, 2)
        XCTAssertEqual(g.step(undo: true), "rotation")
        XCTAssertEqual(g.rotation, 0)
        XCTAssertEqual(g.step(undo: true), "params:warmth")
        XCTAssertEqual(g.params.warmth, 0)              // back to before the whole drag
        XCTAssertNil(g.step(undo: true))
        g.step(undo: false); g.step(undo: false)
        XCTAssertEqual(g.params.warmth, 0.3); XCTAssertEqual(g.rotation, 90)
        g.remember("params:tint"); XCTAssertFalse(g.canRedo)   // a new edit clears redo
        // survives JSON
        let back = try! JSONDecoder().decode(Slide.self, from: JSONEncoder().encode(g))
        XCTAssertEqual(back.history, g.history)
    }

    // MARK: develop with crop and straighten, in place

    func testDevelopCropMatchesPython() throws {
        let base = try ImageFile.load(ParityTests.dir.appendingPathComponent("scene.png"))
        let out = Develop.develop(base, golden.params_crop)
        XCTAssertEqual([out.height, out.width], golden.developed_crop_shape)
        let ref = try Data(contentsOf: ParityTests.dir.appendingPathComponent("developed_crop.f32")).withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
        var sum: Float = 0
        for i in 0..<min(ref.count, out.data.count) { sum += abs(ref[i] - out.data[i]) }
        XCTAssertLessThan(sum / Float(ref.count), 0.02)
    }

    func testCropInPlace() {
        var a = RGBImage(width: 4, height: 3)
        for i in 0..<a.data.count { a.data[i] = Float(i) }
        let copy = a.cropped(top: 1, bottom: 3, left: 1, right: 3)
        a.cropInPlace(top: 1, bottom: 3, left: 1, right: 3)
        XCTAssertEqual(a.data, copy.data)
        XCTAssertEqual([a.width, a.height], [2, 2])
    }

    // MARK: card cleanup and locks

    func testCleanupOnlyDeletesVerifiedScansAndOnlyWhenDone() async throws {
        let root = try tmp()
        let card = root.appendingPathComponent("card")
        let media = card.appendingPathComponent("DCIM/100MEDIA")
        try FileManager.default.createDirectory(at: media, withIntermediateDirectories: true)
        for (i, name) in ["scene.png", "scene_other.png"].enumerated() {
            let img = try ImageFile.load(ParityTests.dir.appendingPathComponent(name))
            try ImageFile.jpeg(img).write(to: media.appendingPathComponent("P\(i).JPG"))
        }
        let library = try Library(root: root.appendingPathComponent("lib"))
        let tray = try await library.createTray(name: "T")
        _ = try await Importer(library: library, renderer: Renderer(library: library)).importScans(into: tray.id, from: card)

        // not uploaded yet: refused
        var t = try await library.load(tray.id)
        XCTAssertFalse(Originals.cleanupBlockers(t).isEmpty)
        do { _ = try await Originals.cleanCard(trayID: tray.id, card: card, library: library); XCTFail("should refuse") } catch {}

        // pretend both are in Immich; one file on the card was replaced by another photo meanwhile
        try await library.update(tray.id) { t in for i in t.groups.indices { t.groups[i].immich = UploadRecord(assetId: "a\(i)", key: t.groups[i].renderKey) } }
        t = try await library.load(tray.id)
        XCTAssertEqual(t.statuses(), [.uploaded, .uploaded])
        try Data("not the same photo".utf8).write(to: media.appendingPathComponent("P1.JPG"))
        // the card mounted somewhere else this time: paths are rebuilt from the card root
        let moved = root.appendingPathComponent("card-again")
        try FileManager.default.moveItem(at: card, to: moved)
        let r = try await Originals.cleanCard(trayID: tray.id, card: moved, library: library)
        XCTAssertEqual(r, Originals.CleanupResult(deleted: 1, missing: 0, mismatched: 1))
        XCTAssertFalse(FileManager.default.fileExists(atPath: moved.appendingPathComponent("DCIM/100MEDIA/P0.JPG").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: moved.appendingPathComponent("DCIM/100MEDIA/P1.JPG").path))
        t = try await library.load(tray.id)
        XCTAssertEqual(t.cardCleaned, false)

        // keep originals off: they go, the slides lock, previews still render from the proxies
        let dropped = try await Originals.dropLocalOriginals(trayID: tray.id, library: library)
        XCTAssertTrue(dropped)
        t = try await library.load(tray.id)
        XCTAssertTrue(t.groups.allSatisfy { $0.locked == "originals" })
        XCTAssertNoThrow(try Renderer(library: library).preview(t, t.groups[0], maxEdge: 200))
    }

    func testFolderImportsAreNeverCleaned() async throws {
        let root = try tmp()
        let folder = root.appendingPathComponent("folder")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try ImageFile.jpeg(try ImageFile.load(ParityTests.dir.appendingPathComponent("scene.png"))).write(to: folder.appendingPathComponent("a.jpg"))
        let library = try Library(root: root.appendingPathComponent("lib"))
        let tray = try await library.createTray(name: "T")
        _ = try await Importer(library: library, renderer: Renderer(library: library)).importScans(into: tray.id, from: folder)
        try await library.update(tray.id) { t in t.groups[0].immich = UploadRecord(assetId: "a", key: t.groups[0].renderKey) }
        let t = try await library.load(tray.id)
        XCTAssertEqual(Originals.cleanupBlockers(t), ["these scans were imported from a folder, not from the scanner's card"])
    }
}
