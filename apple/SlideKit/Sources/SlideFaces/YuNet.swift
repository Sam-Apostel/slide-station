import Foundation
import SlideKit

/// OpenCV's YuNet face detector (`imaging.detect_faces`; `standalone/yunet.ts` in the browser):
/// cv2.FaceDetectorYN's pre-processing, decoding and NMS, the network through ONNX Runtime.
enum YuNet {
    static let scoreThreshold: Float = 0.6
    static let nmsThreshold: Float = 0.3
    static let topK = 5000
    static let strides = [8, 16, 32]

    /// One detection as FaceDetectorYN returns it: box (x, y, w, h), five landmarks (right eye,
    /// left eye, nose, mouth corners), score.
    struct Face: Equatable {
        var box: [Float]
        var landmarks: [Float]
        var score: Float
    }

    struct Frame { var width: Int; var height: Int; var bgr: [UInt8] }

    /// What the detector looks at (`imaging._face_frame`): the picture 800 px wide, area-averaged,
    /// `(x * 255).astype(uint8)` as BGR.
    static func frame(_ a: RGBImage) -> Frame {
        let width = 800, height = Int(800 * Double(a.height) / Double(a.width))
        let s = a.resized(width: width, height: height)
        var bgr = [UInt8](repeating: 0, count: width * height * 3)
        for i in 0..<(width * height) {
            // float32 multiply, then truncate, as numpy does (values are clipped to 0...1 first)
            bgr[i * 3] = UInt8(max(0, min(255, (s.data[i * 3 + 2] * 255).rounded(.towardZero))))
            bgr[i * 3 + 1] = UInt8(max(0, min(255, (s.data[i * 3 + 1] * 255).rounded(.towardZero))))
            bgr[i * 3 + 2] = UInt8(max(0, min(255, (s.data[i * 3] * 255).rounded(.towardZero))))
        }
        return Frame(width: width, height: height, bgr: bgr)
    }

    /// The network input: planar float BGR, zero-padded right and bottom to a multiple of 32
    /// (FaceDetectorYN's padWithDivisor + blobFromImage).
    static func blob(_ f: Frame) -> (data: [Float], padW: Int, padH: Int) {
        let padW = ((f.width - 1) / 32 + 1) * 32, padH = ((f.height - 1) / 32 + 1) * 32
        let plane = padW * padH
        var data = [Float](repeating: 0, count: 3 * plane)
        for y in 0..<f.height {
            for x in 0..<f.width {
                let si = (y * f.width + x) * 3, di = y * padW + x
                data[di] = Float(f.bgr[si])
                data[plane + di] = Float(f.bgr[si + 1])
                data[2 * plane + di] = Float(f.bgr[si + 2])
            }
        }
        return (data, padW, padH)
    }

    /// FaceDetectorYN::postProcess before NMS: every anchor scoring at least the threshold.
    static func decode(_ out: [String: [Float]], padW: Int, padH: Int, threshold: Float = scoreThreshold) -> [Face] {
        var faces: [Face] = []
        for s in strides {
            let cols = padW / s, rows = padH / s
            guard let cls = out["cls_\(s)"], let obj = out["obj_\(s)"], let bbox = out["bbox_\(s)"], let kps = out["kps_\(s)"] else { continue }
            for r in 0..<rows {
                for c in 0..<cols {
                    let i = r * cols + c
                    guard i < cls.count, i < obj.count else { continue }
                    let score = (min(max(cls[i], 0), 1) * min(max(obj[i], 0), 1)).squareRoot()
                    if score < threshold { continue }
                    let fs = Float(s)
                    let cx = (Float(c) + bbox[i * 4]) * fs, cy = (Float(r) + bbox[i * 4 + 1]) * fs
                    let w = exp(bbox[i * 4 + 2]) * fs, h = exp(bbox[i * 4 + 3]) * fs
                    var lm: [Float] = []
                    for n in 0..<5 { lm += [(kps[i * 10 + 2 * n] + Float(c)) * fs, (kps[i * 10 + 2 * n + 1] + Float(r)) * fs] }
                    faces.append(Face(box: [cx - w / 2, cy - h / 2, w, h], landmarks: lm, score: score))
                }
            }
        }
        return faces
    }

    /// cv::dnn::NMSBoxes over the boxes truncated to integers: best first (stable), each kept while
    /// it overlaps no kept box by more than the threshold. A single face skips NMS, as in OpenCV.
    static func nms(_ faces: [Face], threshold: Float = scoreThreshold, overlapLimit: Float = nmsThreshold) -> [Face] {
        if faces.count <= 1 { return faces }
        let rects = faces.map { f in f.box.map { $0.rounded(.towardZero) } }
        var order = faces.indices.filter { faces[$0].score > threshold }
        order.sort { faces[$0].score > faces[$1].score || (faces[$0].score == faces[$1].score && $0 < $1) }
        if topK < order.count { order = Array(order.prefix(topK)) }
        func overlap(_ a: [Float], _ b: [Float]) -> Float {
            let x1 = max(a[0], b[0]), y1 = max(a[1], b[1])
            let w = min(a[0] + a[2], b[0] + b[2]) - x1, h = min(a[1] + a[3], b[1] + b[3]) - y1
            let inter = w <= 0 || h <= 0 ? 0 : w * h
            let union = a[2] * a[3] + b[2] * b[3] - inter
            return union <= 0 ? 0 : inter / union
        }
        var keep: [Int] = []
        for i in order where keep.allSatisfy({ overlap(rects[i], rects[$0]) <= overlapLimit }) { keep.append(i) }
        return keep.map { faces[$0] }
    }

    /// Faces in an upright picture, in its own pixel coordinates (`imaging.detect_faces`).
    static func detect(_ rgb: RGBImage, model: OnnxModel) throws -> [Face] {
        let f = frame(rgb)
        return try detect(frame: f, model: model).map { face in
            let sx = Float(rgb.width) / Float(f.width), sy = Float(rgb.height) / Float(f.height)
            var out = face
            out.box = [face.box[0] * sx, face.box[1] * sy, face.box[2] * sx, face.box[3] * sy]
            out.landmarks = face.landmarks.enumerated().map { $0.offset % 2 == 0 ? $0.element * sx : $0.element * sy }
            return out
        }
    }

    /// Faces in a frame, in the frame's pixels (`imaging._faces_in`).
    static func detect(frame f: Frame, model: OnnxModel) throws -> [Face] {
        let b = blob(f)
        let out = try model.run(b.data, shape: [1, 3, b.padH, b.padW])
        return nms(decode(out, padW: b.padW, padH: b.padH))
    }
}
