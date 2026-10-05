import CoreGraphics
import Foundation
import SlideKit
import Vision

/// Scene tags from Apple's own image classifier (Vision, ~1,300 labels, on the device), as the
/// desktop's tag list: the same 35 tags (insights.LABELS), so a library shared with the desktop
/// tags alike. Each tag is the labels of Vision's taxonomy that mean it; its confidence is the
/// surest of them. Vision has no "village"; "portrait" and "family group" are counted from the faces.
public enum SceneTags {
    /// (tag, Vision labels). The tag is what the user sees and what goes to Immich.
    public static let labels: [(String, [String])] = [
        ("beach", ["beach", "sandcastle"]),
        ("sea", ["ocean"]),
        ("lake", ["lake"]),
        ("snow", ["snow", "snowman", "snowball"]),
        ("skiing", ["skiing", "ski_equipment", "ski_boot", "snowboarding"]),
        ("mountains", ["mountain", "cliff"]),
        ("forest", ["forest"]),
        ("landscape", ["land", "canyon", "desert", "waterfall", "hill", "prairie"]),
        ("sunset", ["sunset_sunrise"]),
        ("city", ["cityscape", "skyscraper"]),
        ("street", ["street", "alley"]),
        ("church", ["belltower"]),
        ("castle", ["castle"]),
        ("wedding", ["wedding", "bride", "groom", "wedding_dress", "wedding_cake", "bridesmaid"]),
        ("birthday", ["birthday_cake"]),
        ("christmas", ["christmas_tree", "christmas_decoration"]),
        ("party", ["celebration", "balloon"]),
        ("car", ["car", "automobile", "sportscar"]),
        ("train", ["train", "train_real", "train_station", "streetcar"]),
        ("airplane", ["airplane", "aircraft"]),
        ("boat", ["boat", "sailboat", "rowboat", "speedboat", "cruise_ship", "watercraft"]),
        ("dog", ["dog"]),
        ("cat", ["cat", "adult_cat", "kitten"]),
        ("horse", ["horse"]),
        ("garden", ["garden"]),
        ("flowers", ["flower", "flower_arrangement", "blossom"]),
        ("children", ["child"]),
        ("baby", ["baby"]),
        ("interior", ["interior_room", "living_room", "bedroom", "kitchen_room", "dining_room"]),
        ("food", ["food"]),
        ("camping", ["camping", "tent"]),
        ("swimming pool", ["pool"]),
    ]
    /// Changing the list (or how faces count) looks at every slide again.
    public static let modelID = "apple-vision-tags-" + String(shortKey(labels.map { "\($0.0):\($0.1.joined(separator: ","))" }.joined(separator: ";") + "|faces1"))

    public static let threshold = 0.3   // Vision's confidence a tag needs (raised per tag by dismissals)
    public static let maxTags = 4

    /// Every tag with its confidence, best first, from Vision's labels and the faces found
    /// (`faces`: boxes as shares of the picture).
    public static func rank(labels found: [String: Double], faces: [CGRect]) -> [(String, Double)] {
        var out = labels.map { tag, ids in (tag, ids.compactMap { found[$0] }.max() ?? 0) }
        let big = faces.filter { $0.width >= 0.05 }
        let people = found["people"] ?? 0
        // one face filling much of the frame; several faces a group (Vision says "people" either way)
        out.append(("portrait", big.count == 1 && big[0].width >= 0.15 ? max(people, 0.5) : 0))
        out.append(("family group", big.count >= 3 ? max(people, 0.5) : 0))
        return out.filter { $0.1 > 0 }.sorted { $0.1 > $1.1 }
    }

    /// The tags to suggest: above the threshold (times `factors[tag]`, from dismissals), at most four.
    public static func suggest(_ ranked: [(String, Double)], factors: [String: Double] = [:]) -> [Insights.Suggestion] {
        ranked.filter { $0.1 >= threshold * (factors[$0.0] ?? 1) }.prefix(maxTags)
            .map { Insights.Suggestion(value: $0.0, confidence: $0.1, source: modelID) }
    }

    /// Vision's labels (confidence > 0.05) and the face boxes on an upright picture.
    public static func look(_ image: CGImage) throws -> (labels: [String: Double], faces: [CGRect]) {
        let classify = VNClassifyImageRequest(), faces = VNDetectFaceRectanglesRequest()
        onCPUInSimulator([classify, faces])
        try VNImageRequestHandler(cgImage: image).perform([classify, faces])
        var labels: [String: Double] = [:]
        for o in classify.results ?? [] where o.confidence > 0.05 { labels[o.identifier] = Double(o.confidence) }
        return (labels, (faces.results ?? []).map(\.boundingBox))
    }
}

func shortKey(_ s: String) -> Substring {
    var h: UInt64 = 0xcbf29ce484222325   // FNV-1a: a stable name for a list, not a secret
    for b in s.utf8 { h = (h ^ UInt64(b)) &* 0x100000001b3 }
    return String(h, radix: 16).prefix(8)
}

/// The simulator has no Neural Engine: Vision's models run there on the CPU only.
func onCPUInSimulator(_ requests: [VNRequest]) {
    #if targetEnvironment(simulator)
    for r in requests {
        if let cpu = try? r.supportedComputeStageDevices[.main]?.first(where: { if case .cpu = $0 { return true }; return false }) {
            r.setComputeDevice(cpu, for: .main)
        }
    }
    #endif
}
