import XCTest
@testable import SlideKit

final class TrayTests: XCTestCase {
    func testDecodesAPythonSession() throws {
        let json = """
        {"id": "20260101-120000-abcd", "name": "Garda 78", "album": "Garda 78", "date": "1978", "created": 1.5,
         "defaults": {"strength": 0.6, "brightness": 0.0, "contrast": 0.0, "warmth": 0.0, "tint": 0.0, "saturation": 0.0,
                      "trim": true, "curves": {}, "angle": 0.0, "crop": null},
         "scans": {"a_123456": {"file": "a_123456.jpg", "source": "/Volumes/X/DCIM/a.jpg", "source_root": "/Volumes/X",
                   "removable": true, "size": 10, "sha1": "abc", "taken": "2026:01:01 10:00:00", "source_deleted": false}},
         "groups": [{"id": "g1", "scans": ["a_123456"], "excluded": [], "rotation": 90, "rot_reason": "faces",
                     "params": {"strength": 0.4, "curves": {"rgb": [[0, 0], [0.5, 0.6], [1, 1]]}}, "reviewed": true, "skip": false,
                     "export": null, "immich": null, "date": "1978-08", "feat": [1, 2, 3]}],
         "log": [[1.0, "Imported"]]}
        """
        let tray = try JSONDecoder().decode(Tray.self, from: Data(json.utf8))
        XCTAssertEqual(tray.groups[0].rotation, 90)
        XCTAssertEqual(tray.groups[0].params.strength, 0.4)
        XCTAssertEqual(tray.groups[0].params.brightness, 0)
        XCTAssertEqual(tray.groups[0].params.curves["rgb"]?.count, 3)
        XCTAssertEqual(tray.scans["a_123456"]?.sourceRoot, "/Volumes/X")
        XCTAssertEqual(tray.statuses(), [.reviewed])
        // round trip keeps the Python field names
        let back = String(decoding: try JSONEncoder().encode(tray), as: UTF8.self)
        XCTAssertTrue(back.contains("\"rot_reason\""))
        XCTAssertTrue(back.contains("\"source_root\""))
    }

    func testStatusFollowsEdits() {
        var g = Slide(scans: ["a"], params: Params())
        XCTAssertEqual(Tray.status(g), .new)
        g.reviewed = true
        XCTAssertEqual(Tray.status(g), .reviewed)
        g.immich = UploadRecord(assetId: "x", key: g.renderKey)
        XCTAssertEqual(Tray.status(g), .uploaded)
        g.params.warmth = 0.2
        XCTAssertEqual(Tray.status(g), .changed)
        g.skip = true
        XCTAssertEqual(Tray.status(g), .skipped)
    }

    func testDates() {
        var tray = Tray(id: "t", name: "T", date: "1977")
        tray.groups = (0..<5).map { _ in Slide(scans: ["s"], params: Params()) }
        tray.groups[1].date = "1978-01"
        tray.groups[3].date = "1978-05"
        let d = SlideDates.estimate(tray)
        XCTAssertEqual(d.map(\.value), ["1978-01", "1978-01", "1978-03", "1978-05", "1978-05"])
        XCTAssertEqual(d.map(\.source), [.near, .own, .between, .own, .near])
        tray.groups[1].date = nil; tray.groups[3].date = nil
        XCTAssertEqual(SlideDates.estimate(tray).map(\.value), Array(repeating: "1977", count: 5))
        XCTAssertNil(SlideDates.parse("78"))
        XCTAssertEqual(SlideDates.parse("1978/6/4")?.1, 3)
    }

    func testImportGroupsAndDedupes() async throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("slidekit-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: tmp) }
        let card = tmp.appendingPathComponent("card/DCIM/100MEDIA")
        try FileManager.default.createDirectory(at: card, withIntermediateDirectories: true)
        let golden = ParityTests.dir
        // a two-exposure bracket of one slide, then another slide
        for (i, name) in ["scene_dark.png", "scene.png", "scene_other.png"].enumerated() {
            let img = try ImageFile.load(golden.appendingPathComponent(name))
            try ImageFile.jpeg(img, quality: 0.95).write(to: card.appendingPathComponent(String(format: "PICT%04d.JPG", i)))
        }
        let library = try Library(root: tmp.appendingPathComponent("lib"))
        let renderer = Renderer(library: library)
        let importer = Importer(library: library, renderer: renderer)
        let tray = try await library.createTray(name: "Test tray")
        let r = try await importer.importScans(into: tray.id, from: tmp.appendingPathComponent("card"))
        XCTAssertEqual(r.imported, 3)
        XCTAssertEqual(r.slides, 2)
        let loaded = try await library.load(tray.id)
        XCTAssertEqual(loaded.groups.map(\.scans.count), [2, 1])
        XCTAssertTrue(loaded.scans.values.allSatisfy(\.removable))
        // previews render
        let preview = try renderer.preview(loaded, loaded.groups[0], maxEdge: 400)
        XCTAssertGreaterThan(preview.width, 100)
        // a second import of the same card copies nothing
        let again = try await importer.importScans(into: tray.id, from: tmp.appendingPathComponent("card"))
        XCTAssertEqual(again.imported, 0)
        XCTAssertEqual(again.skipped, 3)
        // the export carries the date in EXIF
        try await library.update(tray.id) { $0.date = "1978-08" }
        let t = try await library.load(tray.id)
        let jpeg = try Uploader(library: library).render(t, index: 0, estimated: SlideDates.estimate(t))
        let src = CGImageSourceCreateWithData(jpeg as CFData, nil)!
        let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as! [CFString: Any]
        let exif = props[kCGImagePropertyExifDictionary] as! [CFString: Any]
        XCTAssertEqual(exif[kCGImagePropertyExifDateTimeOriginal] as? String, "1978:08:01 12:00:00")
    }

    func testSkySuggestsRotation() {
        // bright, smooth, blue band on the left edge: the picture is lying on its side
        var img = RGBImage(width: 300, height: 200, fill: 0.3)
        for y in 0..<200 { for x in 0..<300 {
            let i = (y * 300 + x) * 3
            if x < 80 { img.data[i] = 0.6; img.data[i + 1] = 0.75; img.data[i + 2] = 0.95 }
            else { let n = Float((x * 7 + y * 13) % 17) / 17; img.data[i] = 0.2 + 0.3 * n; img.data[i + 1] = 0.3 * n; img.data[i + 2] = 0.1 }
        } }
        let (rot, why) = Brackets.suggestRotation([img])
        XCTAssertEqual(rot, 90)
        XCTAssertEqual(why, "sky")
    }
}
