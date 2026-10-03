import CryptoKit
import Foundation
import SlideKit

/// Finds and describes the faces on slides and keeps them in the tray's faces.json
/// (`people.embed_faces`, `record`, `add_face`, `drop_face`).
public final class FaceFinder: @unchecked Sendable {
    /// opencv_zoo's SFace (Apache-2.0), mirrored by OpenCV on Hugging Face, pinned as the browser does.
    public static let modelName = "face_recognition_sface_2021dec.onnx"
    static let modelURL = URL(string: "https://huggingface.co/opencv/face_recognition_sface/resolve/3d7082438a6e4551e840c9b2bb60b71e8da4b524/face_recognition_sface_2021dec.onnx")!
    static let modelSHA256 = "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79"
    public static let modelMB = 39

    public let files: FaceFiles
    private let lock = NSLock()
    private var yunet: OnnxModel?
    private var sface: OnnxModel?

    public init(files: FaceFiles) { self.files = files }

    public var modelFile: URL { files.modelsDir.appendingPathComponent(Self.modelName) }
    /// The face model is in the library (downloaded here, or by the desktop app into a shared one).
    public var modelReady: Bool { FileManager.default.fileExists(atPath: modelFile.path) }

    /// Fetch SFace into the library, checked against its SHA-256. `progress(doneMB, totalMB)`.
    public func downloadModel(progress: @escaping @Sendable (Int, Int) -> Void = { _, _ in }) async throws {
        if modelReady { return }
        try FileManager.default.createDirectory(at: files.modelsDir, withIntermediateDirectories: true)
        let part = modelFile.appendingPathExtension("part")
        FileManager.default.createFile(atPath: part.path, contents: nil)
        let out = try FileHandle(forWritingTo: part)
        defer { try? out.close() }
        let (bytes, response) = try await URLSession.shared.bytes(from: Self.modelURL)
        guard (response as? HTTPURLResponse)?.statusCode ?? 200 < 400 else { throw FacesError.download("The face model couldn't be downloaded (\((response as? HTTPURLResponse)?.statusCode ?? 0)).") }
        let total = Int(response.expectedContentLength > 0 ? response.expectedContentLength : Int64(Self.modelMB << 20))
        var hash = SHA256(), buffer = [UInt8](), done = 0
        buffer.reserveCapacity(1 << 20)
        for try await b in bytes {
            buffer.append(b)
            if buffer.count >= 1 << 20 {
                try Task.checkCancellation()
                hash.update(data: buffer); try out.write(contentsOf: buffer)
                done += buffer.count; buffer.removeAll(keepingCapacity: true)
                progress(done >> 20, total >> 20)
            }
        }
        hash.update(data: buffer); try out.write(contentsOf: buffer)
        try out.close()
        let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
        guard digest == Self.modelSHA256 else {
            try? FileManager.default.removeItem(at: part)
            throw FacesError.download("The downloaded face model didn't match its checksum - try again.")
        }
        try? FileManager.default.removeItem(at: modelFile)
        try FileManager.default.moveItem(at: part, to: modelFile)
    }

    private func models() throws -> (OnnxModel, OnnxModel) {
        try lock.withLock {
            if yunet == nil {
                guard let url = Bundle.module.url(forResource: "face_detection_yunet_2023mar", withExtension: "onnx") else { throw FacesError.model("YuNet is missing from the app") }
                yunet = try OnnxModel(data: Data(try Protobuf.freeInputSize(Array(try Data(contentsOf: url)))))
            }
            if sface == nil {
                guard modelReady else { throw FacesError.model("the face model isn't downloaded yet") }
                sface = try OnnxModel(file: modelFile)
            }
            return (yunet!, sface!)
        }
    }

    /// A face found and described: box (0...1 of the picture), score, unit feature, clothes.
    public struct Found: Sendable { public var box: [Double]; public var score: Double; public var emb: [Float]; public var clothes: [Float]? }

    /// Every clear face in an upright picture (`people.embed_faces`, plus `_dress`).
    public func find(in rgb: RGBImage) throws -> [Found] {
        let (yunet, sface) = try models()
        let faces = try YuNet.detect(rgb, model: yunet)
        let w = Float(rgb.width), h = Float(rgb.height)
        var bgr: [UInt8]?
        var out: [Found] = []
        for f in faces where f.score >= FaceRules.minScore && f.box[2] >= FaceRules.minSize * w {
            if bgr == nil { bgr = SFace.bgr(rgb) }
            let e = try SFace.feature(bgr: bgr!, width: rgb.width, height: rgb.height, landmarks: f.landmarks, model: sface)
            let box = [Double(f.box[0] / w), Double(f.box[1] / h), Double(f.box[2] / w), Double(f.box[3] / h)].map { rounded($0, 4) }
            out.append(Found(box: box, score: rounded(Double(f.score), 3), emb: e, clothes: Clothes.describe(rgb, box: box)))
        }
        return out
    }

    /// The slide's faces need looking at: not yet, or found on other scans / another turn.
    public func stale(tray: String, slide: Slide) -> Bool {
        guard !slide.skip else { return false }
        return files.entries(tray)[slide.id]?["key"]?.text != slide.faceKey
    }

    /// Find and store the faces of one slide (`rgb` = its upright blend). A face found again keeps its
    /// id, so a name or a removal stays with it; a face marked by hand that isn't found stays, turned
    /// with the slide. Answers the faces as stored.
    @discardableResult
    public func record(tray: String, slide g: Slide, rgb: RGBImage) throws -> [StoredFace] {
        let found = try find(in: rgb)
        let key = g.faceKey, gid = g.id
        var stored: [StoredFace] = []
        try files.updateFaces(tray) { d in
            let entry = d[gid]?.dict ?? [:]
            let old = (entry["faces"]?.list ?? [])
            let olds = old.map(FaceFiles.face)
            var used = Set<String>()
            var taken = Set(olds.compactMap { $0.flatMap { Int($0.id.split(separator: "/").last ?? "") } })
            var faces: [JSONValue] = []
            for f in found {
                var match: String?
                if !old.isEmpty {
                    let sims = olds.map { o -> Float in
                        guard let o, !used.contains(o.id), let e = o.emb else { return -1 }
                        return dot(e, f.emb)
                    }
                    if let best = sims.indices.max(by: { sims[$0] < sims[$1] }), sims[best] >= FaceRules.match { match = olds[best]?.id }
                }
                if match == nil {
                    var n = 0
                    while taken.contains(n) { n += 1 }
                    taken.insert(n)
                    match = "\(tray)/\(gid)/\(n)"
                }
                used.insert(match!)
                var o: [String: JSONValue] = ["id": .string(match!), "box": .array(f.box.map { .double($0) }),
                                              "score": .double(f.score), "emb": .string(Half.pack(f.emb))]
                if let c = f.clothes { o["clothes"] = .string(Half.pack(c)) }
                faces.append(.object(o))
            }
            let from = (Int(entry["rot"]?.number ?? 0), entry["mirror"]?.flag ?? false)
            let to = (g.rotation, g.mirror)
            for (raw, o) in zip(old, olds) {   // marked by hand and not found now: kept, turned with the slide
                guard let o, o.manual, !used.contains(o.id), var kept = raw.dict else { continue }
                let box = from == to ? o.box : Self.turn(o.box, from: from, to: to)
                kept["clothes"] = nil; kept["age"] = nil
                kept["box"] = .array(box.map { .double($0) })
                if let c = Clothes.describe(rgb, box: box) { kept["clothes"] = .string(Half.pack(c)) }
                faces.append(.object(kept))
            }
            var e = entry
            e["key"] = .string(key); e["rot"] = .int(g.rotation); e["mirror"] = .bool(g.mirror)
            e["faces"] = .array(faces); e["clothes_v"] = .int(Clothes.version)
            e["ages_by"] = nil   // no ages here: the desktop app adds them again where it has the model
            d[gid] = .object(e)
            stored = faces.compactMap(FaceFiles.face)
        }
        return stored
    }

    /// A box (0...1) on a slide turned `from` (rotation, mirrored) as it is on the slide turned `to`.
    static func turn(_ box: [Double], from: (Int, Bool), to: (Int, Bool)) -> [Double] {
        func unturn(_ p: (Double, Double), _ rot: Int, _ mirror: Bool) -> (Double, Double) {
            var (u, v) = p
            switch ((rot % 360) + 360) % 360 {
            case 90: (u, v) = (v, 1 - u)
            case 180: (u, v) = (1 - u, 1 - v)
            case 270: (u, v) = (1 - v, u)
            default: break
            }
            return mirror ? (1 - u, v) : (u, v)
        }
        func turn(_ p: (Double, Double), _ rot: Int, _ mirror: Bool) -> (Double, Double) {
            let u = mirror ? 1 - p.0 : p.0, v = p.1
            switch ((rot % 360) + 360) % 360 {
            case 90: return (1 - v, u)
            case 180: return (1 - u, 1 - v)
            case 270: return (v, 1 - u)
            default: return (u, v)
            }
        }
        let pts = [(box[0], box[1]), (box[0] + box[2], box[1] + box[3])].map { turn(unturn($0, from.0, from.1), to.0, to.1) }
        let l = pts.map(\.0).min()!, t = pts.map(\.1).min()!
        return [rounded(l, 4), rounded(t, 4), rounded(pts.map(\.0).max()! - l, 4), rounded(pts.map(\.1).max()! - t, 4)]
    }

    /// Someone the detector missed, at `point` (0...1 of the upright picture): the face there if one
    /// is found looking closer at a lower bar, else a box the size of the slide's other faces with no
    /// description (the back of a head: the clothes still say who). Answers its id (`add_face`).
    public func mark(tray: String, slide g: Slide, rgb: RGBImage, point: CGPoint) throws -> String {
        let (yunet, sface) = try models()
        let w = Double(rgb.width), h = Double(rgb.height)
        let px = point.x * w, py = point.y * h
        var best: YuNet.Face?
        for share in [0.18, 0.35, 0.6] {   // small faces to large ones
            let half = share * min(w, h) / 2
            let x0 = Int(max(0, px - half)), y0 = Int(max(0, py - half)), x1 = Int(min(w, px + half)), y1 = Int(min(h, py + half))
            guard x1 - x0 >= 8, y1 - y0 >= 8 else { continue }
            let crop = rgb.cropped(top: y0, bottom: y1, left: x0, right: x1)
            let scale = 480 / Double(max(crop.width, crop.height))
            let small = crop.resized(width: max(1, Int(Double(crop.width) * scale)), height: max(1, Int(Double(crop.height) * scale)))
            let frame = YuNet.Frame(width: small.width, height: small.height, bgr: SFace.bgr(small))
            for var f in try YuNet.detect(frame: frame, model: yunet) {
                let s = Float(scale)
                f.box = [f.box[0] / s + Float(x0), f.box[1] / s + Float(y0), f.box[2] / s, f.box[3] / s]
                f.landmarks = f.landmarks.enumerated().map { $0.element / s + Float($0.offset % 2 == 0 ? x0 : y0) }
                let fx = Double(f.box[0]), fy = Double(f.box[1]), fw = Double(f.box[2]), fh = Double(f.box[3])
                // the spot is on the face, or just below it (the chin, the neck)
                guard fx - 0.3 * fw <= px, px <= fx + 1.3 * fw, fy - 0.3 * fh <= py, py <= fy + 1.6 * fh else { continue }
                if best == nil || f.score > best!.score { best = f }
            }
        }
        var face: [String: JSONValue]
        if let b = best {
            let e = try SFace.feature(bgr: SFace.bgr(rgb), width: rgb.width, height: rgb.height, landmarks: b.landmarks, model: sface)
            let box = [Double(b.box[0]) / w, Double(b.box[1]) / h, Double(b.box[2]) / w, Double(b.box[3]) / h].map { rounded($0, 4) }
            face = ["box": .array(box.map { .double($0) }), "score": .double(rounded(Double(b.score), 3)), "emb": .string(Half.pack(e))]
        } else {
            let sizes = (files.entries(tray)[g.id]?["faces"]?.list ?? []).compactMap(FaceFiles.face).map { $0.box[2] * w }.sorted()
            let side = sizes.isEmpty ? 0.08 * min(w, h) : sizes[sizes.count / 2]
            let bw = side / w, bh = side / h
            let box = [min(max(point.x - bw / 2, 0), 1 - bw), min(max(point.y - bh / 2, 0), 1 - bh), bw, bh].map { rounded($0, 4) }
            face = ["box": .array(box.map { .double($0) }), "score": .double(0)]
        }
        if case .array(let b)? = face["box"], let c = Clothes.describe(rgb, box: b.compactMap(\.number)) { face["clothes"] = .string(Half.pack(c)) }
        var id = ""
        try files.updateFaces(tray) { d in
            guard var e = d[g.id]?.dict, e["key"]?.text == g.faceKey else {
                throw FacesError.model("This slide's faces are being looked for: try again in a moment.")
            }
            var list = e["faces"]?.list ?? []
            let taken = Set(list.compactMap(FaceFiles.face).compactMap { Int($0.id.split(separator: "/").last ?? "") })
            var n = 0
            while taken.contains(n) { n += 1 }
            id = "\(tray)/\(g.id)/\(n)"
            face["id"] = .string(id); face["manual"] = .bool(true)
            list.append(.object(face))
            e["faces"] = .array(list)
            d[g.id] = .object(e)
        }
        return id
    }

    /// Forget a face marked by hand (nobody there after all). Faces the detector found can't go
    /// (they'd be found again): those are "not them" instead.
    public func drop(face: String) throws {
        let parts = face.split(separator: "/").map(String.init)
        guard parts.count == 3 else { return }
        try files.updateFaces(parts[0]) { d in
            guard var e = d[parts[1]]?.dict, var list = e["faces"]?.list,
                  let i = list.firstIndex(where: { FaceFiles.face($0).map { $0.id == face && $0.manual } ?? false }) else { return }
            list.remove(at: i)
            e["faces"] = .array(list)
            d[parts[1]] = .object(e)
        }
    }
}
