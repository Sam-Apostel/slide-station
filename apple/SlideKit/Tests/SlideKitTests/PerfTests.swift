import Darwin
import XCTest
@testable import SlideKit

/// Full-resolution export of a 3-scan bracket at the scanner's size (~20 MP). Slow and memory-heavy,
/// so it only runs when asked:  SLIDEKIT_PERF=1 swift test -c release --filter PerfTests
/// Run it on its own: the peak it reports is the whole process's.
final class PerfTests: XCTestCase {
    static let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("slidekit-perf")

    override func setUpWithError() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["SLIDEKIT_PERF"] == "1", "set SLIDEKIT_PERF=1")
    }

    /// Three exposures of a synthetic 5472 × 3648 slide, written once and reused.
    static func bracket() throws -> [URL] {
        let urls = (0..<3).map { dir.appendingPathComponent("scan\($0).jpg") }
        if urls.allSatisfy({ FileManager.default.fileExists(atPath: $0.path) }) { return urls }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let w = 5472, h = 3648
        for (i, gain) in [Float(0.6), 1, 1.5].enumerated() {
            var img = RGBImage(width: w, height: h)
            img.data.withUnsafeMutableBufferPointer { p in
                for y in 0..<h {
                    for x in 0..<w {
                        let o = (y * w + x) * 3
                        let sky = y < h / 2 + Int(300 * sin(Double(x) / 400))
                        let n = Float((x &* 7 &+ y &* 13) % 23) / 23
                        p[o] = min(1, (sky ? 0.55 : 0.25 + 0.2 * n) * gain)
                        p[o + 1] = min(1, (sky ? 0.6 : 0.3 + 0.1 * n) * gain)
                        p[o + 2] = min(1, (sky ? 0.8 : 0.15) * gain)
                    }
                }
            }
            try ImageFile.jpeg(img, quality: 0.9).write(to: urls[i])
        }
        return urls
    }

    static func footprint() -> (now: Double, peak: Double) {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        _ = withUnsafeMutablePointer(to: &info) { $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) } }
        return (Double(info.phys_footprint) / 1_048_576, Double(info.ledger_phys_footprint_peak) / 1_048_576)
    }

    func testFullResolutionExport() throws {
        let urls = try Self.bracket()
        let before = Self.footprint()
        let t0 = Date()
        let jpeg = try Export.fullResolution(scans: urls, rotation: 90, params: Params())
        let dt = Date().timeIntervalSince(t0)
        let after = Self.footprint()
        print(String(format: "PERF export: %.1f s, %.1f MB jpeg, footprint before %.0f MB, peak %.0f MB", dt, Double(jpeg.count) / 1e6, before.now, after.peak))
        XCTAssertGreaterThan(jpeg.count, 1_000_000)
    }
}
