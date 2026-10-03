import Foundation
import SlideKit

/// OpenCV's SFace (`cv2.FaceRecognizerSF`: alignCrop on YuNet's five landmarks to its 112 × 112
/// template, then the network): a 128-d feature per face, unit length, so the cosine similarity of
/// two faces is their dot product. Ported as the browser version did (`standalone/people.ts`).
enum SFace {
    static let size = 112
    static let template: [[Float]] = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]]

    /// OpenCV's getSimilarityTransformMatrix: the rotation + scale + shift taking the landmarks to the
    /// template (Umeyama's least squares, the 2 × 2 SVD in closed form), as a 2 × 3 matrix.
    static func similarityTransform(_ landmarks: [Float]) -> [Double] {
        let pts = (0..<5).map { [landmarks[$0 * 2], landmarks[$0 * 2 + 1]] }
        let mean = (0..<2).map { j in pts.reduce(Float(0)) { $0 + $1[j] } / 5 }
        let dstMean: [Float] = [56.0262, 71.9008]
        let sd = pts.map { [$0[0] - mean[0], $0[1] - mean[1]] }
        let dd = template.map { [$0[0] - dstMean[0], $0[1] - dstMean[1]] }
        var a00 = 0.0, a01 = 0.0, a10 = 0.0, a11 = 0.0
        for i in 0..<5 {   // float products summed in double, as the C++ does
            a00 += Double(dd[i][0] * sd[i][0]); a01 += Double(dd[i][0] * sd[i][1])
            a10 += Double(dd[i][1] * sd[i][0]); a11 += Double(dd[i][1] * sd[i][1])
        }
        a00 /= 5; a01 /= 5; a10 /= 5; a11 /= 5
        let theta = atan2(a10 - a01, a00 + a11)
        let c = cos(theta), s = sin(theta)
        var v1 = 0.0, v2 = 0.0
        for p in sd { v1 += Double(p[0] * p[0]); v2 += Double(p[1] * p[1]) }
        let scale = (1 / (v1 / 5 + v2 / 5)) * hypot(a00 + a11, a10 - a01)
        let m0 = Double(mean[0]), m1 = Double(mean[1])
        let t0 = c * m0 - s * m1, t1 = s * m0 + c * m1
        return [c * scale, -s * scale, Double(dstMean[0]) - scale * t0, s * scale, c * scale, Double(dstMean[1]) - scale * t1]
    }

    /// cv2.warpAffine(img, M, (112, 112), INTER_LINEAR), border 0, of 8-bit BGR: each output pixel's
    /// source point in float, bilinear weights in float, rounded.
    static func warp(_ bgr: [UInt8], width w: Int, height h: Int, _ M: [Double]) -> [UInt8] {
        let det = M[0] * M[4] - M[1] * M[3]
        let i0 = M[4] / det, i1 = -M[1] / det, i3 = -M[3] / det, i4 = M[0] / det
        let i2 = -(i0 * M[2] + i1 * M[5]), i5 = -(i3 * M[2] + i4 * M[5])
        let m = [i0, i1, i2, i3, i4, i5].map { Float($0) }
        var out = [UInt8](repeating: 0, count: size * size * 3)
        func px(_ x: Int, _ y: Int, _ c: Int) -> Float { x < 0 || y < 0 || x >= w || y >= h ? 0 : Float(bgr[(y * w + x) * 3 + c]) }
        for y in 0..<size {
            for x in 0..<size {
                let sx = m[0] * Float(x) + m[1] * Float(y) + m[2]
                let sy = m[3] * Float(x) + m[4] * Float(y) + m[5]
                let x0 = Int(sx.rounded(.down)), y0 = Int(sy.rounded(.down))
                let ax = sx - Float(x0), ay = sy - Float(y0)
                for c in 0..<3 {
                    let top = px(x0, y0, c) * (1 - ax) + px(x0 + 1, y0, c) * ax
                    let bot = px(x0, y0 + 1, c) * (1 - ax) + px(x0 + 1, y0 + 1, c) * ax
                    let v = (top * (1 - ay) + bot * ay).rounded()
                    out[(y * size + x) * 3 + c] = UInt8(max(0, min(255, v)))
                }
            }
        }
        return out
    }

    /// SFace's input: blobFromImage(aligned, 1, (112, 112), swapRB = true), planar RGB 0...255.
    static func input(_ aligned: [UInt8]) -> [Float] {
        let n = size * size
        var out = [Float](repeating: 0, count: 3 * n)
        for i in 0..<n { for c in 0..<3 { out[c * n + i] = Float(aligned[i * 3 + 2 - c]) } }
        return out
    }

    /// The whole picture as 8-bit BGR, `(np.clip(rgb, 0, 1) * 255).astype(np.uint8)`.
    static func bgr(_ rgb: RGBImage) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: rgb.width * rgb.height * 3)
        for i in 0..<(rgb.width * rgb.height) {
            for c in 0..<3 { out[i * 3 + c] = UInt8((min(1, max(0, rgb.data[i * 3 + 2 - c])) * 255).rounded(.towardZero)) }
        }
        return out
    }

    /// The unit 128-d feature of one face (landmarks in the picture's pixels).
    static func feature(bgr: [UInt8], width: Int, height: Int, landmarks: [Float], model: OnnxModel) throws -> [Float] {
        let aligned = warp(bgr, width: width, height: height, similarityTransform(landmarks))
        let out = try model.run(input(aligned), shape: [1, 3, size, size])
        guard let v = out.values.first(where: { $0.count == 128 }) ?? out.values.first else { throw FacesError.model("SFace gave nothing back") }
        return unit(v)
    }
}

func unit(_ v: [Float]) -> [Float] {
    let n = v.reduce(Float(0)) { $0 + $1 * $1 }.squareRoot()
    return n > 0 ? v.map { $0 / n } : v
}

func dot(_ a: [Float], _ b: [Float]) -> Float {
    var s: Float = 0
    for i in 0..<min(a.count, b.count) { s += a[i] * b[i] }
    return s
}
