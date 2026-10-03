import Foundation
@testable import SlideFaces
import SlideKit
import XCTest

/// YuNet + SFace through ONNX Runtime against OpenCV on real photos. Not committed (people's faces):
/// point SLIDEFACES_REAL at a folder with models/face_recognition_sface_2021dec.onnx, the pictures as
/// raw float32 RGB (<name>.f32) and OpenCV's answers (ref.json), as made by a script like
/// `cv2.FaceDetectorYN` + `cv2.FaceRecognizerSF` in people.embed_faces.
final class RealFacesTests: XCTestCase {
    func testDetectionsAndFeaturesMatchOpenCV() throws {
        guard let dir = ProcessInfo.processInfo.environment["SLIDEFACES_REAL"] else { throw XCTSkip("set SLIDEFACES_REAL") }
        let root = URL(fileURLWithPath: dir)
        let ref = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("ref.json"))) as! [String: [String: Any]]
        let finder = FaceFinder(files: FaceFiles(root: root))
        for (name, r) in ref {
            let w = r["width"] as! Int, h = r["height"] as! Int
            let raw = try Data(contentsOf: root.appendingPathComponent("\(name).f32"))
            let rgb = RGBImage(width: w, height: h, data: raw.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) })
            let found = try finder.find(in: rgb)
            let want = r["faces"] as! [[String: Any]]
            XCTAssertEqual(found.count, want.count, name)
            for (f, x) in zip(found, want) {
                for (a, b) in zip(f.box, x["box"] as! [Double]) { XCTAssertEqual(a, b, accuracy: 0.002, "\(name) box") }
                XCTAssertEqual(f.score, x["score"] as! Double, accuracy: 0.002, "\(name) score")
                let cos = dot(f.emb, (x["emb"] as! [Double]).map(Float.init))
                print("\(name): score \(f.score), cosine with OpenCV's feature \(cos)")
                XCTAssertGreaterThan(cos, 0.99, "\(name) feature")
            }
        }
    }
}
