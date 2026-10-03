import Foundation
#if canImport(OnnxRuntimeBindings)
import OnnxRuntimeBindings
#endif

public enum FacesError: LocalizedError {
    case noRuntime
    case model(String)
    case download(String)

    public var errorDescription: String? {
        switch self {
        case .noRuntime: "Finding faces isn't available on this device."
        case .model(let s): "The face model couldn't run: \(s)"
        case .download(let s): s
        }
    }
}

/// One ONNX model, run on the CPU (the desktop app's `onnxruntime` / `cv2.dnn`, the browser's
/// onnxruntime-web). A run at a time: sessions are thread-safe, but two big runs at once only
/// fight over the cores.
final class OnnxModel: @unchecked Sendable {
    #if canImport(OnnxRuntimeBindings)
    private static let env: ORTEnv? = try? ORTEnv(loggingLevel: .warning)
    private let session: ORTSession
    #endif
    private let lock = NSLock()
    let inputName: String

    init(data: Data) throws {
        #if canImport(OnnxRuntimeBindings)
        guard let env = Self.env else { throw FacesError.noRuntime }
        let options = try ORTSessionOptions()
        try options.setIntraOpNumThreads(Int32(max(1, min(4, ProcessInfo.processInfo.activeProcessorCount - 1))))
        try options.setGraphOptimizationLevel(.all)
        // the session wants a file; models are small enough to pass through a temporary one
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("model-\(UUID().uuidString).onnx")
        try data.write(to: tmp)
        defer { try? FileManager.default.removeItem(at: tmp) }
        session = try ORTSession(env: env, modelPath: tmp.path, sessionOptions: options)
        inputName = try session.inputNames().first ?? "input"
        #else
        throw FacesError.noRuntime
        #endif
    }

    convenience init(file: URL) throws { try self.init(data: try Data(contentsOf: file, options: .mappedIfSafe)) }

    /// One forward pass: a float tensor of `shape` in, every output by name (as flat floats).
    func run(_ input: [Float], shape: [Int]) throws -> [String: [Float]] {
        #if canImport(OnnxRuntimeBindings)
        lock.lock(); defer { lock.unlock() }
        let data = input.withUnsafeBufferPointer { NSMutableData(bytes: $0.baseAddress, length: $0.count * MemoryLayout<Float>.size) }
        let value = try ORTValue(tensorData: data, elementType: .float, shape: shape.map { NSNumber(value: $0) })
        let names = try session.outputNames()
        let out = try session.run(withInputs: [inputName: value], outputNames: Set(names), runOptions: nil)
        var result: [String: [Float]] = [:]
        for (name, v) in out {
            let d = try v.tensorData() as Data
            result[name] = d.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
        }
        return result
        #else
        throw FacesError.noRuntime
        #endif
    }
}

// MARK: - YuNet's input size

/// The YuNet ONNX file declares a fixed 640 × 640 input, which OpenCV ignores but ONNX Runtime
/// enforces. The graph works at any size (it reshapes with -1), so the input's height and width are
/// rewritten as free (named) dimensions and the declared output and intermediate shapes dropped: a
/// minimal protobuf rewrite, as the browser version does (`standalone/yunet.ts`). ModelProto.graph (7)
/// → GraphProto.input (11) / output (12) / value_info (13) → ValueInfoProto.type (2) →
/// TypeProto.tensor_type (1) → shape (2) → dim (1).
enum Protobuf {
    struct Field { var no: Int; var wire: Int; var start: Int; var end: Int; var body: Range<Int>? }

    static func varint(_ b: [UInt8], _ o: inout Int) -> Int {
        var v = 0, shift = 0
        while true {
            let byte = b[o]; o += 1
            v |= Int(byte & 0x7f) << shift
            if byte < 0x80 { return v }
            shift += 7
        }
    }

    static func fields(_ b: [UInt8]) throws -> [Field] {
        var out: [Field] = []
        var o = 0
        while o < b.count {
            let start = o
            let tag = varint(b, &o)
            let no = tag >> 3, wire = tag & 7
            var body: Range<Int>?
            switch wire {
            case 0: _ = varint(b, &o)
            case 1: o += 8
            case 5: o += 4
            case 2:
                let len = varint(b, &o)
                body = o..<(o + len)
                o += len
            default: throw FacesError.model("unsupported protobuf wire type \(wire)")
            }
            out.append(Field(no: no, wire: wire, start: start, end: o, body: body))
        }
        return out
    }

    static func encodeVarint(_ v: Int) -> [UInt8] {
        var v = v, out: [UInt8] = []
        while v >= 0x80 { out.append(UInt8(v & 0x7f) | 0x80); v >>= 7 }
        out.append(UInt8(v))
        return out
    }

    static func lenField(_ no: Int, _ body: [UInt8]) -> [UInt8] { encodeVarint(no << 3 | 2) + encodeVarint(body.count) + body }

    enum Change { case keep, drop, replace([UInt8]) }

    /// The message with the length-delimited fields `fn` picks replaced or dropped.
    static func rewrite(_ b: [UInt8], _ fn: (Field, [UInt8]) throws -> Change) throws -> [UInt8] {
        var out: [UInt8] = []
        out.reserveCapacity(b.count)
        for f in try fields(b) {
            guard let r = f.body else { out += b[f.start..<f.end]; continue }
            switch try fn(f, Array(b[r])) {
            case .keep: out += b[f.start..<f.end]
            case .drop: break
            case .replace(let body): out += lenField(f.no, body)
            }
        }
        return out
    }

    /// A tensor ValueInfoProto with its dims rewritten by `shape` (nil: no declared shape).
    static func withShape(_ info: [UInt8], _ shape: ([[UInt8]]) -> [[UInt8]]?) throws -> [UInt8] {
        try rewrite(info) { f, type in
            guard f.no == 2 else { return .keep }
            return .replace(try rewrite(type) { t, tensor in
                guard t.no == 1 else { return .keep }
                return .replace(try rewrite(tensor) { s, dimsBody in
                    guard s.no == 2 else { return .keep }
                    let dims = try fields(dimsBody).filter { $0.no == 1 }.compactMap { $0.body.map { Array(dimsBody[$0]) } }
                    guard let new = shape(dims) else { return .drop }
                    return .replace(new.flatMap { lenField(1, $0) })
                })
            })
        }
    }

    static func dimParam(_ name: String) -> [UInt8] { lenField(2, Array(name.utf8)) }

    /// The model with a free-size input (N, C, height, width) and no fixed output shapes.
    static func freeInputSize(_ model: [UInt8]) throws -> [UInt8] {
        try rewrite(model) { f, graph in
            guard f.no == 7 else { return .keep }
            return .replace(try rewrite(graph) { g, body in
                switch g.no {
                case 11: return .replace(try withShape(body) { d in d.count == 4 ? [d[0], d[1], dimParam("height"), dimParam("width")] : d })
                case 12: return .replace(try withShape(body) { _ in nil })
                case 13: return .drop
                default: return .keep
                }
            })
        }
    }

    /// The declared input dimensions (numbers, or names for free ones): for the tests.
    static func inputDims(_ model: [UInt8]) throws -> [String] {
        func first(_ b: [UInt8], _ no: Int) throws -> [UInt8] {
            guard let f = try fields(b).first(where: { $0.no == no }), let r = f.body else { throw FacesError.model("no field \(no)") }
            return Array(b[r])
        }
        let shape = try first(try first(try first(try first(try first(model, 7), 11), 2), 1), 2)
        return try fields(shape).filter { $0.no == 1 }.compactMap { d -> String? in
            guard let r = d.body else { return nil }
            let dim = Array(shape[r])
            guard let v = try fields(dim).first else { return nil }
            if v.no == 1 { var o = v.start + 1; return String(varint(dim, &o)) }
            return v.body.map { String(decoding: dim[$0], as: UTF8.self) }
        }
    }
}
