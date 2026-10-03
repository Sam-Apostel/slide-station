import Foundation
import Observation
import SlideInsights
import SlideKit

/// Suggestions for the open tray's slides (the desktop's insights worker, insights.step): scene
/// tags, a caption and a place, from Apple's own models, never applied silently. One slide at a
/// time in the background, the slide on screen first, while no job runs; committed only if the
/// slide is still the same (scans, turn, caption or not), with every decision already made kept.
@MainActor @Observable
final class InsightsModel {
    var tags: Bool { didSet { UserDefaults.standard.set(tags, forKey: "insightsTags") } }
    var captions: Bool { didSet { UserDefaults.standard.set(captions, forKey: "insightsCaptions") } }
    var places: Bool { didSet { UserDefaults.standard.set(places, forKey: "insightsPlaces") } }

    /// Whether Apple Intelligence can caption here (asked again when Settings shows).
    private(set) var captionAvailability = Captions.availability
    /// The slide being looked at now (its id), for "Looking at this slide…".
    private(set) var working: String?

    @ObservationIgnored private(set) var learning: InsightsLearning
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var failed: Set<String> = []   // slide|key that threw: not again this run

    init(root: URL) {
        let d = UserDefaults.standard
        tags = d.object(forKey: "insightsTags") as? Bool ?? true
        captions = d.object(forKey: "insightsCaptions") as? Bool ?? true
        places = d.object(forKey: "insightsPlaces") as? Bool ?? true
        learning = InsightsLearning(root: root)
    }

    func use(root: URL) { learning = InsightsLearning(root: root); failed = [] }

    var analyzer: Analyzer { Analyzer(tags: tags, captions: captions, places: places) }
    var on: Bool { !analyzer.models.isEmpty }

    func checkAvailability() { captionAvailability = Captions.availability }

    /// The slide's key now: what decisions on it compare with (a caption typed keeps it fresh).
    func key(_ g: Slide) -> String? { on ? analyzer.key(g) : nil }

    func pending(_ tray: Tray) -> Int {
        let a = analyzer
        return a.models.isEmpty ? 0 : tray.groups.filter { a.needsAnalysis($0) }.count
    }

    /// Keep looking at slides while the app runs.
    func start(_ app: AppModel) {
        guard loop == nil else { return }
        loop = Task { [weak self, weak app] in
            while !Task.isCancelled {
                guard let self, let app else { return }
                let did = await self.step(app)
                try? await Task.sleep(for: .seconds(did ? 0.2 : 1.5))
            }
        }
    }

    /// Look at the next slide that needs it, the one on screen first. Returns whether it did.
    private func step(_ app: AppModel) async -> Bool {
        let a = analyzer
        guard !a.models.isEmpty, !app.busy, let tray = app.tray else { return false }
        let n = tray.groups.count
        guard n > 0 else { return false }
        let start = min(max(app.selection, 0), n - 1)
        guard let g = (0..<n).lazy.map({ tray.groups[(start + $0) % n] })
            .first(where: { a.needsAnalysis($0) && $0.locked == nil && !self.failed.contains("\($0.id)|\(a.key($0))") }) else { return false }
        working = g.id
        defer { working = nil }
        let renderer = app.renderer, factors = learning.factors()
        do {
            let new = try await Task.detached(priority: .utility) { () async throws -> [String: JSONValue] in
                var rgb = try renderer.fusedProxy(tray, g).oriented(g.rotation, mirror: g.mirror)
                Develop.developInPlace(&rgb, g.params)   // the colours as they'll be: a faded slide reads better developed
                return try await a.analyse(g, image: ImageFile.cgImage(rgb), factors: factors)
            }.value
            app.commitInsights(g.id, new, key: { a.key($0) })
        } catch {
            // noted on the slide (as the desktop does), so it isn't tried again until it changes
            failed.insert("\(g.id)|\(a.key(g))")
            app.commitInsights(g.id, ["key": .string(a.key(g)), "error": .string(error.localizedDescription)], key: { a.key($0) })
        }
        return true
    }
}
