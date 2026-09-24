import XCTest
@testable import SlideKit

/// SlideKit against the Python pipeline, on synthetic slides (`Tests/make_golden.py`).
final class ParityTests: XCTestCase {
    struct Golden: Decodable {
        var width: Int, height: Int
        var trim_bounds: [Int]
        var developed_shape: [Int]
        var params: Params, params_neg: Params
        var curve_points: [[Double]], curve_lut: [Double]
        var fit_curves: [String: [[Double]]]
        var neutral: [Double]
        var sim_same: Double, sim_other: Double
        var quality: [Brackets.Quality]
    }

    static let dir = Bundle.module.resourceURL!.appendingPathComponent("Golden")
    lazy var golden: Golden = try! JSONDecoder().decode(Golden.self, from: Data(contentsOf: Self.dir.appendingPathComponent("golden.json")))

    func image(_ name: String) throws -> RGBImage { try ImageFile.load(Self.dir.appendingPathComponent(name)) }

    func floats(_ name: String) throws -> [Float] {
        try Data(contentsOf: Self.dir.appendingPathComponent(name)).withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
    }

    /// Mean and worst absolute difference between two float buffers.
    func diff(_ a: [Float], _ b: [Float], file: StaticString = #filePath, line: UInt = #line) -> (Float, Float) {
        XCTAssertEqual(a.count, b.count, "size", file: file, line: line)
        var sum: Float = 0, worst: Float = 0
        for i in 0..<min(a.count, b.count) { let d = abs(a[i] - b[i]); sum += d; worst = max(worst, d) }
        return (sum / Float(max(1, a.count)), worst)
    }

    func testLoadsTheSamePixels() throws {
        let a = try image("scene.png")
        XCTAssertEqual(a.width, golden.width)
        XCTAssertEqual(a.height, golden.height)
    }

    func testAutoRestore() throws {
        let out = Develop.autoRestore(try image("scene.png"), strength: 0.6)
        let (mean, worst) = diff(out.data, try floats("restored.f32"))
        XCTAssertLessThan(mean, 0.002)
        XCTAssertLessThan(worst, 0.05)
    }

    func testTrimBounds() throws {
        let restored = RGBImage(width: golden.width, height: golden.height, data: try floats("restored.f32"))
        let (t, b, l, r) = Develop.trimBounds(restored)
        XCTAssertEqual([t, b, l, r], golden.trim_bounds)
    }

    func testDevelop() throws {
        let out = Develop.develop(try image("scene.png"), golden.params)
        XCTAssertEqual([out.height, out.width], golden.developed_shape)
        let (mean, worst) = diff(out.data, try floats("developed.f32"))
        XCTAssertLessThan(mean, 0.003)
        XCTAssertLessThan(worst, 0.06)
    }

    func testDevelopNegativeContrastNoTrim() throws {
        let (mean, _) = diff(Develop.develop(try image("scene.png"), golden.params_neg).data, try floats("developed_neg.f32"))
        XCTAssertLessThan(mean, 0.003)
    }

    func testCurveLUT() {
        let lut = Curves.lut(golden.curve_points, n: 64)
        for (a, b) in zip(lut, golden.curve_lut) { XCTAssertEqual(Double(a), b, accuracy: 1e-5) }
    }

    func testFitCurves() throws {
        let fit = Develop.fitCurves(Develop.toneBase(try image("scene.png"), Params()), [:])
        XCTAssertEqual(Set(fit.keys), Set(golden.fit_curves.keys))
        for (k, pts) in golden.fit_curves {
            for (a, b) in zip(fit[k]!, pts) { XCTAssertEqual(a[0], b[0], accuracy: 0.01, k); XCTAssertEqual(a[1], b[1], accuracy: 1e-6, k) }
        }
    }

    func testNeutralBalance() throws {
        let (w, t) = Develop.neutralBalance(try image("scene.png"), Params(), x: 0.2, y: 0.2)
        XCTAssertEqual(w, golden.neutral[0], accuracy: 0.02)
        XCTAssertEqual(t, golden.neutral[1], accuracy: 0.02)
    }

    func testGrouping() throws {
        let a = Brackets.signature(try image("scene.png"))
        let d = Brackets.signature(try image("scene_dark.png"))
        let o = Brackets.signature(try image("scene_other.png"))
        XCTAssertEqual(Double(Brackets.similarity(a, d)), golden.sim_same, accuracy: 0.01)
        XCTAssertEqual(Double(Brackets.similarity(a, o)), golden.sim_other, accuracy: 0.03)
        let (groups, continues) = Brackets.groupSequence([a, d, o, o])
        XCTAssertEqual(groups, [[0, 1], [2, 3]])
        XCTAssertFalse(continues)
        let (g2, c2) = Brackets.groupSequence([d, o], previous: [a])
        XCTAssertEqual(g2, [[0], [1]])
        XCTAssertTrue(c2)
    }

    func testScanQuality() throws {
        let q = [Brackets.quality(try image("scene.png")), Brackets.quality(try image("scene_dark.png"))]
        for (a, b) in zip(q, golden.quality) {
            XCTAssertEqual(a.clipped, b.clipped, accuracy: 0.01)
            XCTAssertEqual(a.sharp, b.sharp, accuracy: b.sharp * 0.15)
        }
    }

    func testWeakScans() {
        let q = [Brackets.Quality(sharp: 1, clipped: 0), Brackets.Quality(sharp: 0.4, clipped: 0), Brackets.Quality(sharp: 0.9, clipped: 0.9)]
        XCTAssertEqual(Brackets.weakScans(q), [1: "blurry", 2: "clipped"])
        XCTAssertEqual(Brackets.weakScans([Brackets.Quality(sharp: 1, clipped: 0.9), Brackets.Quality(sharp: 0.5, clipped: 0.95)]), [1: "clipped"])
    }

    func testFusion() throws {
        let fused = Fusion.fuse([try image("scene_dark.png"), try image("scene.png"), try image("scene_bright.png")], align: false)
        let (mean, _) = diff(fused.data, try floats("fused.f32"))
        XCTAssertLessThan(mean, 0.01)
    }

    func testAlignmentUndoesAShift() throws {
        let base = try image("scene.png")
        let moved = Fusion.shifted(try image("scene_bright.png"), dx: 3, dy: -2)
        let aligned = Fusion.align([base, moved])[1].rgbImage()
        let (mean, _) = diff(aligned.data, try image("scene_bright.png").data)
        let (before, _) = diff(moved.data, try image("scene_bright.png").data)
        XCTAssertLessThan(mean, before / 3)
        // identical scans stay where they are
        XCTAssertEqual(Fusion.align([base, base])[1].rgbImage().data, base.data)
    }

    func testStraighten() throws {
        let out = Develop.straighten(try image("scene.png"), angle: 4)
        let ref = try floats("straight4.f32")
        // compare away from the edges, where border handling differs
        var sum: Float = 0, n = 0
        for y in 10..<(out.height - 10) { for x in 10..<(out.width - 10) { for c in 0..<3 {
            let i = (y * out.width + x) * 3 + c; sum += abs(out.data[i] - ref[i]); n += 1
        } } }
        XCTAssertLessThan(sum / Float(n), 0.01)
    }

    func testRotateRoundTrip() throws {
        let a = try image("scene.png")
        let r = a.rotated(90)
        XCTAssertEqual([r.width, r.height], [a.height, a.width])
        XCTAssertEqual(r.rotated(270).data, a.data)
        XCTAssertEqual(a.rotated(180).rotated(180).data, a.data)
        // clockwise: the top-left pixel ends up top-right
        XCTAssertEqual(Array(r.data[((r.width - 1)) * 3..<(r.width * 3)]), Array(a.data[0..<3]))
    }

    // MARK: mount detection, dust & scratch repair

    struct Repair: Decodable {
        struct Found: Decodable { var angle: Double, confidence: Double, box: [Double?] }
        var mount: Found, mount_none: Found
        var mount_box_rot90: [Double?], mount_params: Params, mount_crop_rot90: [Double]
        var dust_amount: Double, dust_marked: Int, dust_r: Int
    }

    lazy var repair: Repair = try! JSONDecoder().decode(Repair.self, from: Data(contentsOf: Self.dir.appendingPathComponent("golden.json")))

    func testMountDetection() throws {
        let mnt = try image("mount.png")
        let m = Develop.detectMount(mnt)
        XCTAssertEqual(m.angle, repair.mount.angle, accuracy: 0.02)
        XCTAssertEqual(m.confidence, repair.mount.confidence, accuracy: 0.03)
        for (a, b) in zip(m.box, repair.mount.box) { XCTAssertEqual(a!, b!, accuracy: 0.002) }
        XCTAssertEqual(Develop.rotateBox(repair.mount.box, 90), repair.mount_box_rot90)
        XCTAssertEqual(Develop.rotateBox(Develop.rotateBox(repair.mount.box, 180), 180), repair.mount.box)
        let crop = try XCTUnwrap(Develop.mountCrop(mnt.rotated(90), repair.mount_params, box: repair.mount_box_rot90))
        for (a, b) in zip(crop, repair.mount_crop_rot90) { XCTAssertEqual(a, b, accuracy: 0.002) }
        let scene = try image("scene.png")
        let inside = Develop.detectMount(scene.cropped(top: 8, bottom: scene.height - 8, left: 8, right: scene.width - 8))
        XCTAssertEqual(inside.confidence, 0)
    }

    func testDustRepair() throws {
        let dusty = try image("dusty.png")
        let (mask, r) = Develop.dustMask(dusty, amount: repair.dust_amount)
        XCTAssertEqual(r, repair.dust_r)
        XCTAssertEqual(mask.reduce(0) { $0 + Int($1) }, repair.dust_marked)
        let (mean, worst) = diff(Develop.repairDust(dusty, amount: repair.dust_amount).data, try floats("dust.f32"))
        XCTAssertLessThan(mean, 1e-5)
        XCTAssertLessThan(worst, 1e-3)
        XCTAssertEqual(Develop.repairDust(dusty, amount: 0).data, dusty.data)
    }

    // MARK: mould and Newton rings

    struct Damage: Decodable {
        var mould_amount: Double, mould_marked: Int, mould_r: Int
        var newton_amount: Double, newton_weight_sum: Double, newton_weight_samples: [Double]
    }

    lazy var damage: Damage = try! JSONDecoder().decode(Damage.self, from: Data(contentsOf: Self.dir.appendingPathComponent("golden.json")))

    func testMouldRepair() throws {
        let mouldy = try image("mouldy.png")
        let (mask, r) = Develop.mouldMask(mouldy, amount: damage.mould_amount)
        XCTAssertEqual(r, damage.mould_r)
        XCTAssertEqual(mask.reduce(0) { $0 + Int($1) }, damage.mould_marked)
        let (mean, worst) = diff(Develop.repairMould(mouldy, amount: damage.mould_amount).data, try floats("mould.f32"))
        XCTAssertLessThan(mean, 1e-5)
        XCTAssertLessThan(worst, 1e-3)
        XCTAssertEqual(Develop.repairMould(mouldy, amount: 0).data, mouldy.data)
    }

    func testNewtonRingRemoval() throws {
        let ringed = try image("rings.png")
        let (weight, _) = Develop.newtonWeight(ringed, amount: damage.newton_amount)
        XCTAssertEqual(weight.reduce(0, +), damage.newton_weight_sum, accuracy: 1e-6 * Double(weight.count))
        for (k, (y, x)) in [(100, 96), (40, 40), (170, 260), (200, 300)].enumerated() {
            XCTAssertEqual(weight[y * ringed.width + x], damage.newton_weight_samples[k], accuracy: 1e-6)
        }
        let (mean, worst) = diff(Develop.repairNewton(ringed, amount: damage.newton_amount).data, try floats("newton.f32"))
        XCTAssertLessThan(mean, 1e-5)
        XCTAssertLessThan(worst, 1e-3)
        XCTAssertEqual(Develop.repairNewton(ringed, amount: 0).data, ringed.data)
    }

    struct Local: Decodable {
        struct MaskStats: Decodable { var shape: [Int], sum: Double, samples: [Double] }
        var params_local: Params, developed_local_shape: [Int]
        var local_masks: [MaskStats], local_mask_size: [Int], local_turned: [LocalAdjustment]
    }

    lazy var local: Local = try! JSONDecoder().decode(Local.self, from: Data(contentsOf: Self.dir.appendingPathComponent("golden.json")))

    func testLocalAdjustmentMasks() {
        let (w, h) = (local.local_mask_size[0], local.local_mask_size[1])
        let cells = [(0, 0), (300, 400), (500, 200), (100, 900), (600, 1000), (437, 409), (437, 609), (156, 859), (156, 767)]
        for (adj, want) in zip(local.params_local.local, local.local_masks) {
            let m = Develop.localMask(adj, width: w, height: h)
            XCTAssertEqual([m.height, m.width], want.shape)
            XCTAssertEqual(m.data.reduce(0.0) { $0 + Double($1) }, want.sum, accuracy: max(1, want.sum) * 1e-5)
            for ((j, i), v) in zip(cells, want.samples) { XCTAssertEqual(Double(m.data[j * m.width + i]), v, accuracy: 1e-6) }
        }
        XCTAssertEqual(LocalAdjustment.turned(local.params_local.local, by: 90), local.local_turned)
        XCTAssertEqual(LocalAdjustment.turned(LocalAdjustment.turned(local.params_local.local, by: 180), by: 180), local.params_local.local)
    }

    func testDevelopWithLocalAdjustments() throws {
        let out = Develop.develop(try image("local.png"), local.params_local)
        XCTAssertEqual([out.height, out.width], local.developed_local_shape)
        let (mean, worst) = diff(out.data, try floats("developed_local.f32"))
        XCTAssertLessThan(mean, 0.003)
        XCTAssertLessThan(worst, 0.06)
    }

    // MARK: over-exposed scans

    struct Blown: Decodable {
        struct Case: Decodable { var scales: [Float], strength: Double }
        var restore_blown: Case
    }

    lazy var blown: Blown = try! JSONDecoder().decode(Blown.self, from: Data(contentsOf: Self.dir.appendingPathComponent("golden.json")))

    func testAutoRestoreBlownOut() throws {
        let scene = try image("scene.png")
        let want = try floats("restored_blown.f32")
        let n = scene.data.count
        for (i, k) in blown.restore_blown.scales.enumerated() {
            let over = RGBImage(width: scene.width, height: scene.height, data: scene.data.map { min(1, max(0, $0 * k)) })
            let out = Develop.autoRestore(over, strength: blown.restore_blown.strength)
            XCTAssertTrue(out.data.allSatisfy { $0.isFinite }, "x\(k)")
            let (mean, worst) = diff(out.data, Array(want[(i * n)..<((i + 1) * n)]))
            XCTAssertLessThan(mean, 0.002, "x\(k)")
            XCTAssertLessThan(worst, 0.05, "x\(k)")
        }
    }
}
