import Foundation
@testable import SlideFaces
@testable import SlideKit
import XCTest

/// people.json edits on a made-up library: faces.json written directly, features as made-up
/// identities (tests/test_people.py does the same with embed_faces replaced).
final class PeopleTests: XCTestCase {
    var root: URL!
    var files: FaceFiles!
    var people: People!
    /// Each tray's slides in order (s0, s1, …).
    var order: [String: [String]] = [:]

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("people-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("sessions"), withIntermediateDirectories: true)
        files = FaceFiles(root: root)
        let box = Box(order)
        people = People(files: files) { box.value[$0] ?? [] }
        self.box = box
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: root) }

    final class Box: @unchecked Sendable { var value: [String: [String]]; init(_ v: [String: [String]]) { value = v } }
    var box: Box!

    /// A unit vector near identity `who` (made-up people A, B, C…). `who` ≥ 100: only a little like
    /// identity `who - 100` (a blend with someone else), as a faded side view might be.
    func face(_ who: Int, _ jitter: Int) -> [Float] {
        if who >= 100 { return unit(zip(face(who - 100, jitter), face(50, jitter)).map { 0.3 * $0 + 0.95 * $1 }) }
        var v = (0..<128).map { i in Float(sin(Double(i * (who + 3)) * 1.7 + Double(who))) }
        for i in 0..<128 { v[i] += 0.35 * Float(sin(Double(i * 13 + jitter * 31 + who * 7))) }
        return unit(v)
    }

    /// slides: [[(identity, clothes colour)]] → faces.json for `tray`.
    func tray(_ tray: String, _ slides: [[(Int, Int)]]) throws {
        try FileManager.default.createDirectory(at: root.appendingPathComponent("sessions/\(tray)"), withIntermediateDirectories: true)
        var d: [String: JSONValue] = [:]
        for (i, faces) in slides.enumerated() {
            let gid = "s\(i)"
            let list: [JSONValue] = faces.enumerated().map { n, f in
                var clothes = [Float](repeating: 0, count: 144)
                clothes[f.1] = 1
                return .object(["id": .string("\(tray)/\(gid)/\(n)"), "box": .array([.double(0.1 + 0.3 * Double(n)), .double(0.2), .double(0.1), .double(0.15)]),
                                "score": .double(0.9), "emb": .string(Half.pack(face(f.0, i * 10 + n))), "clothes": .string(Half.pack(clothes))])
            }
            d[gid] = .object(["key": .string("k"), "rot": .int(0), "mirror": .bool(false), "faces": .array(list)])
        }
        try files.write(files.facesURL(tray), d)
        box.value[tray] = slides.indices.map { "s\($0)" }
    }

    func testFacesBecomePeopleAcrossTrays() throws {
        try tray("t1", [[(0, 1)], [(0, 1), (1, 2)], [(1, 2)]])
        try tray("t2", [[(0, 3)], [(1, 4)]])
        let d = try people.refresh()
        XCTAssertEqual(d.ids.count, 2)
        let sizes = d.ids.map { d.faces($0).count }.sorted()
        XCTAssertEqual(sizes, [3, 3])
        for p in d.ids {   // one person, one identity
            let trays = Set(d.faces(p).map { String($0.prefix(2)) })
            XCTAssertEqual(trays, ["t1", "t2"])
        }
    }

    func testANameSomeoneHasJoinsThem() throws {
        try tray("t1", [[(0, 1)], [(1, 2)]])
        var d = try people.refresh()
        let (a, b) = (d.ids[0], d.ids[1])
        d = try people.rename(a, "  Mum  ")
        XCTAssertEqual(d.name(a), "Mum")
        d = try people.rename(b, "mum")
        XCTAssertEqual(d.ids.count, 1, "the same name is the same person")
        XCTAssertEqual(d.faces(d.ids[0]).count, 2)
    }

    func testAssigningAFaceTakesItOutAndBringsItsGroup() throws {
        // identity 0 on four slides of one tray and once in another: one cluster of five
        try tray("t1", [[(0, 1)], [(0, 1)], [(0, 1)], [(2, 9)]])
        try tray("t2", [[(0, 5)]])
        var d = try people.refresh()
        let group = try XCTUnwrap(d.ids.first { d.faces($0).count == 4 })
        d = try people.assign("t1/s0/0", to: .new("Dad"))
        let dad = try XCTUnwrap(d.ids.first { d.name($0) == "Dad" })
        XCTAssertEqual(Set(d.faces(dad)), ["t1/s0/0", "t1/s1/0", "t1/s2/0", "t2/s0/0"], "the rest of the group came along")
        XCTAssertTrue(d.sure(dad).contains("t1/s0/0"))
        XCTAssertNil(d.people[group], "the unnamed group emptied out and went")
        // not him after all: taken out and remembered
        d = try people.assign("t1/s1/0", to: .nobody)
        XCTAssertFalse(d.faces(dad).contains("t1/s1/0"))
        XCTAssertEqual(d.rejected["t1/s1/0"], [dad])
        XCTAssertNotEqual(d.owner(of: "t1/s1/0"), dad, "clustering never puts it back")
    }

    func testNamesSpreadToTheSameClothesNearby() throws {
        // Ann, then a face only a little like hers in the same red (1) on the next slide; the same
        // face in blue (7) five slides on
        try tray("t1", [[(0, 1)], [(100, 1)], [], [], [], [], [(100, 7)]])
        var d = try people.refresh()
        let first = try XCTUnwrap(d.owner(of: "t1/s0/0"))
        d = try people.rename(first, "Ann")
        let ann = try XCTUnwrap(d.ids.first { d.name($0) == "Ann" })
        let look = dot(face(0, 0), face(100, 10))
        XCTAssert((FaceRules.looksLike..<FaceRules.samePerson).contains(look), "only a little like her: \(look)")
        XCTAssertEqual(d.owner(of: "t1/s1/0"), ann, "a little like her, in her clothes, next to her: her")
        XCTAssertNotEqual(d.owner(of: "t1/s6/0"), ann, "too far away, other clothes")
    }

    func testLikeliestNamesFirst() throws {
        try tray("t1", [[(0, 1)], [(1, 2)], [(0, 1), (1, 2)]])
        var d = try people.refresh()
        d = try people.assign("t1/s0/0", to: .new("Ann"))
        d = try people.assign("t1/s1/0", to: .new("Bob"))
        let ann = d.ids.first { d.name($0) == "Ann" }!, bob = d.ids.first { d.name($0) == "Bob" }!
        let l = people.likely("t1/s2/0", d)
        XCTAssertGreaterThan(l[ann]!, l[bob]!, "looks like Ann")
        XCTAssertGreaterThan(l[ann]!, Double(FaceRules.samePerson))
    }

    func testIgnoredPeopleStayIgnoredAndKeepUnknownFields() throws {
        try tray("t1", [[(0, 1)], [(0, 1)]])
        var d = try people.refresh()
        let p = d.ids[0]
        // fields only the desktop app knows survive an edit here
        var raw = files.read(files.peopleURL)
        var ppl = raw["people"]!.dict!
        var person = ppl[p]!.dict!
        person["immich"] = .object(["id": .string("imm-1"), "name": .string("")])
        ppl[p] = .object(person); raw["people"] = .object(ppl); raw["ages_off"] = .array([.string("t1/s0/0")])
        try files.write(files.peopleURL, raw)
        d = try people.setIgnored([p], true)
        XCTAssertTrue(d.ignored(p))
        XCTAssertEqual(d.people[p]?["immich"]?["id"]?.text, "imm-1")
        XCTAssertEqual(files.read(files.peopleURL)["ages_off"]?.list?.count, 1)
        d = try people.rename(p, "Neighbour")
        XCTAssertFalse(d.ignored(p), "a name means they matter")
    }
}
