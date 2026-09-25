import XCTest
@testable import SlideKit

/// Boxes (Python: tests/test_boxes.py): a numbered box holds two trays, left and right, of 50
/// slides (or 36, the shorter boxes). A box can have writing on it, a tray can't, a slide's mount can.
final class BoxTests: XCTestCase {
    var root: URL!
    var lib: Library!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("boxes-\(UUID().uuidString)")
        lib = try Library(root: root)
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: root) }

    func testTrayInABoxIsNamedAfterIt() async throws {
        let t = try await lib.createTray(name: "", box: 12, side: .left)
        XCTAssertEqual(t.name, "Box 12 left")
        XCTAssertEqual(t.album, "Box 12 left")
        let back = try await lib.load(t.id)
        XCTAssertEqual(back.box, 12)
        XCTAssertEqual(back.side, .left)
        let boxes = await lib.boxes()
        XCTAssertEqual(boxes[12], Box(number: 12, size: 50, writing: ""))
    }

    func testAGivenNameWins() async throws {
        let t = try await lib.createTray(name: "Italy 1978", box: 3, side: .right)
        XCTAssertEqual(t.name, "Italy 1978")
    }

    func testOneTrayPerSide() async throws {
        _ = try await lib.createTray(name: "", box: 4, side: .left)
        do {
            _ = try await lib.createTray(name: "", box: 4, side: .left)
            XCTFail("two trays on one side")
        } catch let e as BoxError {
            XCTAssertEqual(e, .taken("Box 4 left", by: "Box 4 left"))
        }
        _ = try await lib.createTray(name: "", box: 4, side: .right)
    }

    func testShortBoxAndItsWriting() async throws {
        try await lib.saveBox(5, size: 36, writing: "Kerst '79")
        try await lib.saveBox(5)   // a tray going in leaves what's known about the box alone
        var boxes = await lib.boxes()
        XCTAssertEqual(boxes[5], Box(number: 5, size: 36, writing: "Kerst '79"))
        try await lib.saveBox(5, writing: "Kerst '79 + '80")
        boxes = await lib.boxes()
        XCTAssertEqual(boxes[5]?.size, 36)
        XCTAssertEqual(boxes[5]?.writing, "Kerst '79 + '80")
        do {
            try await lib.saveBox(5, size: 40)
            XCTFail("a box of 40")
        } catch let e as BoxError { XCTAssertEqual(e, .badSize) }
    }

    func testMovingATrayRenamesItUnlessNamed() async throws {
        let t = try await lib.createTray(name: "", box: 6, side: .left)
        var m = try await lib.move(t.id, box: 7, side: .right)
        XCTAssertEqual(m.name, "Box 7 right")
        XCTAssertEqual(m.album, "Box 7 right")
        _ = try await lib.update(t.id) { $0.name = "Wedding" }
        m = try await lib.move(t.id, box: 7, side: .left)
        XCTAssertEqual(m.name, "Wedding")
        XCTAssertEqual(m.album, "Box 7 left")
        m = try await lib.move(t.id, box: nil, side: nil)
        XCTAssertNil(m.box)
        XCTAssertEqual(m.name, "Wedding")
    }

    func testCantMoveOntoATakenSide() async throws {
        _ = try await lib.createTray(name: "", box: 8, side: .left)
        let t = try await lib.createTray(name: "", box: 8, side: .right)
        do {
            try await lib.move(t.id, box: 8, side: .left)
            XCTFail("moved onto a taken side")
        } catch is BoxError {}
    }

    /// What the Python app writes: `"box": null` on trays outside a box, `boxes.json` with string keys.
    func testReadsThePythonFiles() async throws {
        let json = """
        {"id": "20260101-120000-abcd", "name": "Box 9 right", "album": "Box 9 right", "box": 9, "side": "right",
         "date": "", "created": 1.5, "defaults": {}, "scans": {},
         "groups": [{"id": "g1", "scans": ["a"], "excluded": [], "rotation": 0, "rot_reason": "", "params": {},
                     "reviewed": false, "skip": false, "export": null, "immich": null, "writing": "Oma, Knokke"}],
         "log": []}
        """
        let tray = try JSONDecoder().decode(Tray.self, from: Data(json.utf8))
        XCTAssertEqual(tray.box, 9)
        XCTAssertEqual(tray.side, .right)
        XCTAssertEqual(tray.groups[0].writing, "Oma, Knokke")
        let none = try JSONDecoder().decode(Tray.self, from: Data(json.replacingOccurrences(of: "\"box\": 9, \"side\": \"right\"", with: "\"box\": null, \"side\": null").utf8))
        XCTAssertNil(none.box)
        XCTAssertNil(none.side)

        try Data(#"{"boxes": {"10": {"size": 36, "writing": "Paris"}, "2": {"size": 50, "writing": ""}}}"#.utf8)
            .write(to: root.appendingPathComponent("boxes.json"))
        let boxes = await lib.boxes()
        XCTAssertEqual(boxes[10], Box(number: 10, size: 36, writing: "Paris"))
        XCTAssertEqual(boxes[2]?.size, 50)
    }

    /// Writing on a slide isn't the photo: it doesn't make an uploaded slide need uploading again.
    func testWritingDoesntChangeTheUpload() {
        var g = Slide(scans: ["a"], params: Params())
        g.reviewed = true
        g.immich = UploadRecord(assetId: "x", key: g.renderKey, meta: nil)
        g.writing = "Oma, Knokke"
        XCTAssertEqual(Tray.status(g), .uploaded)
    }
}
