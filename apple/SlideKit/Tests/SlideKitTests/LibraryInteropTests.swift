import XCTest
@testable import SlideKit

/// A tray shared with the Python app must survive being saved here, and both apps must agree on
/// what's uploaded.
final class LibraryInteropTests: XCTestCase {
    /// A group as the Python app writes it, fields this app doesn't model included; the keys are
    /// what `store.render_key` / `store.meta_key` give for it.
    static let pythonTray = """
    {"id": "t1", "name": "Garda", "album": "Garda", "date": "1978", "created": 1.5, "placed": {"x": 1}, "tray_tag": "tag-1",
     "defaults": {"strength": 0.6, "brightness": 0.0, "contrast": 0.0, "warmth": 0.0, "tint": 0.0, "saturation": 0.0, "trim": true},
     "scans": {"a": {"file": "a.jpg", "source": "/Volumes/X/a.jpg", "source_root": "/Volumes/X", "removable": true, "size": 10,
                     "sha1": "abc", "taken": "2026:01:01 10:00:00", "source_deleted": true}},
     "groups": [{"id": "g1", "scans": ["a"], "excluded": [], "rotation": 90, "mirror": true, "rot_reason": "faces",
                 "params": {"strength": 0.4, "brightness": 0.0, "contrast": 0.1, "warmth": -0.25, "tint": 0.0, "saturation": 0.0,
                            "trim": true, "curves": {"rgb": [[0.0, 0.05], [1.0, 1.0]]}, "angle": 0.0, "crop": null},
                 "reviewed": true, "skip": false, "export": {"key": "k"}, "developed_at": 12.5, "insights": {"faces": 2},
                 "caption": "Lake", "tags": ["b", "a"], "place": {"lat": 45.6, "lon": 10.66666666, "name": "Garda"},
                 "immich": {"asset_id": "x", "key": "RENDER", "meta": "META", "stack_id": "s1", "originals": {"a": "o1"}}}],
     "log": [[1.0, "Imported"]]}
    """

    func tempLibrary() throws -> (Library, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("slidekit-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("sessions/t1"), withIntermediateDirectories: true)
        return (try Library(root: root), root)
    }

    func testKeysMatchPython() throws {
        let tray = try JSONDecoder().decode(Tray.self, from: Data(Self.pythonTray.utf8))
        let g = tray.groups[0]
        XCTAssertEqual(g.renderKey, "000a70f96317")
        XCTAssertEqual(Tray.metaKey(g, date: SlideDates.estimate(tray)[0]), "315d446982b8")
    }

    func testSavingKeepsWhatPythonWrote() async throws {
        let (library, root) = try tempLibrary()
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("sessions/t1/session.json")
        try Data(Self.pythonTray.utf8).write(to: file)
        let original = try JSONValue.parse(Data(contentsOf: file))

        try await library.update("t1") { _ in }
        XCTAssertEqual(try JSONValue.parse(Data(contentsOf: file)), original, "an untouched tray is written back as it was")

        try await library.update("t1") { $0.groups[0].params.warmth = 0.5; $0.name = "Garda 78" }
        let after = try JSONValue.parse(Data(contentsOf: file))
        XCTAssertEqual(after["name"], .string("Garda 78"))
        XCTAssertEqual(after["placed"], original["placed"])
        XCTAssertEqual(after["tray_tag"], original["tray_tag"])
        guard case .array(let gs) = after["groups"], case .array(let was) = original["groups"] else { return XCTFail() }
        XCTAssertEqual(gs[0]["params"]?["warmth"], .double(0.5))
        XCTAssertEqual(gs[0]["params"]?["brightness"], .double(0), "still a float for Python")
        for k in ["export", "developed_at", "insights", "tags", "place", "mirror", "immich"] {
            XCTAssertEqual(gs[0][k], was[0][k], k)
        }
    }

    /// Opt-in: every tray of a real Python library (`SLIDEKIT_LIBRARY=~/Pictures/Slide\\ Station`),
    /// copied, saved here and compared; statuses go to `SLIDEKIT_STATUSES` for a Python check.
    func testRealLibrary() async throws {
        guard let path = ProcessInfo.processInfo.environment["SLIDEKIT_LIBRARY"] else { throw XCTSkip("set SLIDEKIT_LIBRARY") }
        let src = URL(fileURLWithPath: path).appendingPathComponent("sessions")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("slidekit-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent("sessions"), withIntermediateDirectories: true)
        let library = try Library(root: root)
        var statuses: [String: [String]] = [:]
        for dir in try FileManager.default.contentsOfDirectory(at: src, includingPropertiesForKeys: nil) {
            let id = dir.lastPathComponent
            let from = dir.appendingPathComponent("session.json")
            guard FileManager.default.fileExists(atPath: from.path) else { continue }
            try FileManager.default.createDirectory(at: library.trayDir(id), withIntermediateDirectories: true)
            let to = library.trayDir(id).appendingPathComponent("session.json")
            try FileManager.default.copyItem(at: from, to: to)
            let tray = try await library.update(id) { _ in }
            XCTAssertEqual(try JSONValue.parse(Data(contentsOf: to)), try JSONValue.parse(Data(contentsOf: from)), id)
            statuses[id] = tray.statuses().map(\.rawValue)
        }
        if let out = ProcessInfo.processInfo.environment["SLIDEKIT_STATUSES"] {
            try JSONEncoder().encode(statuses).write(to: URL(fileURLWithPath: out))
        }
    }
}
