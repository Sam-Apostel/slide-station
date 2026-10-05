import CoreGraphics
import Foundation
import SlideKit

/// One slide's fresh suggestions from the models turned on (insights._analyse): the decisions
/// already made are merged in by `Insights.merge`, when it is committed.
public struct Analyzer: Sendable {
    public var tags: Bool
    public var captions: Bool
    public var places: Bool
    public var lookup: @Sendable (String) async -> Slide.Place?

    public init(tags: Bool, captions: Bool, places: Bool, lookup: @escaping @Sendable (String) async -> Slide.Place? = { await CityLookup.shared.city($0) }) {
        self.tags = tags; self.captions = captions; self.places = places; self.lookup = lookup
    }

    /// What looks at a slide now: part of every slide's key, so turning one on looks again.
    public var models: [String] {
        var out: [String] = []
        if tags { out.append(SceneTags.modelID) }
        if captions && Captions.availability == .ready { out.append(Captions.modelID) }
        if places { out.append(SignPlaces.ocrID) }
        return out
    }

    public func key(_ g: Slide) -> String { Insights.key(g, models: models, captionModel: Captions.modelID) }
    public func needsAnalysis(_ g: Slide) -> Bool { Insights.needsAnalysis(g, models: models, captionModel: Captions.modelID) }

    /// The suggestions for slide `g` from its upright picture. A kind no model computed is left out.
    public func analyse(_ g: Slide, image: CGImage, factors: [String: Double]) async throws -> [String: JSONValue] {
        let models = models
        var out: [String: JSONValue] = ["key": .string(key(g))]
        if models.contains(SceneTags.modelID) {
            let seen = try SceneTags.look(image)
            out["tags"] = .array(SceneTags.suggest(SceneTags.rank(labels: seen.labels, faces: seen.faces), factors: factors).map(\.json))
        }
        if models.contains(Captions.modelID), (g.caption ?? "").isEmpty, let c = try await Captions.caption(image) {
            out["caption"] = c.json
        }
        if models.contains(SignPlaces.ocrID) {
            let lines = try SignPlaces.read(image)
            out["text"] = .array(lines.prefix(20).map { .object(["text": .string($0.text), "confidence": .double(($0.confidence * 1000).rounded() / 1000)]) })
            if let p = await SignPlaces.place(from: lines, lookup: lookup) { out["place"] = p.json }
        }
        return out
    }
}
