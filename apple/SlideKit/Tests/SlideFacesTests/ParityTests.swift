import Foundation
@testable import SlideFaces
@testable import SlideKit
import XCTest

/// SlideFaces against slidestation/people.py's own answers (Tests/make_faces_fixtures.py).
final class ParityTests: XCTestCase {
    static let fixture: [String: Any] = {
        let url = Bundle.module.url(forResource: "people", withExtension: "json", subdirectory: "Fixtures")!
        return try! JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    }()

    func testFaceKeyMatchesPython() throws {
        for c in Self.fixture["keys"] as! [[String: Any]] {
            var s = Slide(id: "g1", scans: c["scans"] as! [String], params: Params())
            s.excluded = c["excluded"] as! [String]
            s.rotation = c["rotation"] as! Int
            s.mirror = c["mirror"] as! Bool
            XCTAssertEqual(s.faceKey, c["key"] as! String, "\(c)")
        }
    }

    func testFloat16PackingMatchesNumpy() {
        let p = Self.fixture["pack"] as! [String: Any]
        let v = (p["vector"] as! [Double]).map(Float.init)
        XCTAssertEqual(Half.pack(v), p["packed"] as! String)
        let back = unit(Half.unpack(p["packed"] as! String)!)
        for (a, b) in zip(back, p["unpacked"] as! [Double]) { XCTAssertEqual(Double(a), b, accuracy: 1e-6) }
        XCTAssertEqual(Half.pack((p["special"] as! [Double]).map(Float.init)), p["special_packed"] as! String)
    }

    func testClusteringMatchesPython() {
        for (n, c) in (Self.fixture["agglomerate"] as! [[String: Any]]).enumerated() {
            let emb = (c["emb"] as! [[Double]]).map { $0.map(Float.init) }
            var rejected: [Int: Set<Int>] = [:]
            for (k, v) in c["rejected"] as! [String: [Int]] { rejected[Int(k)!] = Set(v) }
            let groups = agglomerate(emb, clusters: c["clusters"] as! [[Int]], rejected: rejected, slides: c["slides"] as? [String])
            XCTAssertEqual(groups, c["groups"] as! [[Int]], "case \(n)")
        }
    }

    func testClothesMatchPython() throws {
        let c = Self.fixture["clothes"] as! [String: Any]
        let w = c["width"] as! Int, h = c["height"] as! Int
        let raw = Data(base64Encoded: c["rgb"] as! String)!
        let rgb = RGBImage(width: w, height: h, data: raw.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) })
        let hist = try XCTUnwrap(Clothes.describe(rgb, box: c["box"] as! [Double]))
        let want = (c["hist"] as! [Double]).map(Float.init)
        XCTAssertEqual(hist.count, want.count)
        // OpenCV's Lab and resize round a little differently: close, and alike as clothes go
        for (a, b) in zip(hist, want) { XCTAssertEqual(a, b, accuracy: 0.02) }
        XCTAssertGreaterThan(Clothes.like(hist, want)!, 0.99)
        XCTAssertEqual(Clothes.describe(rgb, box: c["edge_box"] as! [Double]) == nil, c["edge"] as! Bool)
        let mirrored = (c["mirrored_hist"] as! [Double]).map(Float.init)
        XCTAssertEqual(Double(Clothes.like(want, mirrored)!), c["like_mirrored"] as! Double, accuracy: 1e-4)
    }

    func testTurnedBoxesMatchPython() {
        for c in Self.fixture["turn"] as! [[String: Any]] {
            let f = c["from"] as! [Any], t = c["to"] as! [Any]
            let out = FaceFinder.turn(c["box"] as! [Double], from: (f[0] as! Int, f[1] as! Bool), to: (t[0] as! Int, t[1] as! Bool))
            for (a, b) in zip(out, c["out"] as! [Double]) { XCTAssertEqual(a, b, accuracy: 1e-9, "\(c)") }
        }
    }
}
