import Observation
import SlideKit
import SwiftUI

/// All app state and every action, in one place (the SwiftUI counterpart of
/// `frontend/src/hooks/use-slide-station.ts`). Heavy work runs off the main actor; the tray on
/// screen is edited optimistically and saved through `Library.update`.
@MainActor @Observable
final class AppModel {
    let library: Library
    let renderer: Renderer
    let previews: PreviewCache

    private(set) var trays: [Tray] = []
    /// The open tray, with local edits applied immediately.
    private(set) var tray: Tray?
    var selection = 0

    private(set) var job: JobProgress?
    private var jobTask: Task<Void, Never>?
    var notice: String?
    var error: String?

    /// The scanner card as last seen (nil = not plugged in / never picked).
    private(set) var card: CardSource?
    private let bookmark = CardBookmark()
    var cardPicked: Bool { cardURL() != nil || bookmark.isSet }

    private func cardURL() -> URL? {
        #if DEBUG
        if let path = DebugLaunch.cardPath { return path }
        #endif
        return bookmark.resolve()
    }

    var immich: ImmichSettings {
        didSet { UserDefaults.standard.set(immich.url, forKey: "immichURL"); Keychain.set(immich.key, for: "immichKey") }
    }

    init() {
        let root = Library.defaultRoot()
        library = try! Library(root: root)
        renderer = Renderer(library: library)
        previews = PreviewCache(renderer: renderer)
        RendererSizes.shared.library = library
        learning = Learning.Model(url: root.appendingPathComponent("learning.json"))
        immich = ImmichSettings(url: UserDefaults.standard.string(forKey: "immichURL") ?? "", key: Keychain.get("immichKey") ?? "")
        learningEnabled = UserDefaults.standard.object(forKey: "learningEnabled") as? Bool ?? true
        keepOriginals = UserDefaults.standard.object(forKey: "keepOriginals") as? Bool ?? true
    }

    var slide: Slide? { tray.flatMap { $0.groups.indices.contains(selection) ? $0.groups[selection] : nil } }
    var statuses: [SlideStatus] { tray?.statuses() ?? [] }
    var busy: Bool { job != nil }

    // MARK: trays

    func refresh() async {
        trays = await library.trays()
        if let id = tray?.id, let fresh = try? await library.load(id) { tray = fresh }
    }

    func open(_ id: String) async {
        guard let t = try? await library.load(id) else { return }
        tray = t
        // start where the work is: the first slide not developed or skipped yet
        selection = t.groups.firstIndex { !$0.reviewed && !$0.skip } ?? 0
    }

    func close() { tray = nil; Task { await refresh() } }

    func rename(_ name: String, album: String, date: String) {
        guard let id = tray?.id else { return }
        tray?.name = name; tray?.album = album; tray?.date = date
        Task { try? await library.update(id) { $0.name = name; $0.album = album; $0.date = date }; await refresh() }
    }

    func delete(_ id: String) async {
        try? await library.deleteTray(id)
        if tray?.id == id { tray = nil }
        await refresh()
    }

    // MARK: card

    /// iPadOS has no "drive mounted" event: check whenever the app becomes active.
    func checkCard() async {
        guard let url = cardURL() else { card = nil; return }
        let index = await library.importedIndex()
        card = await Task.detached {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            return CardSource.inspect(url, index: index)
        }.value
    }

    func pickCard(_ url: URL) async {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do { try bookmark.save(url) } catch { self.error = "Couldn't remember that folder: \(error.localizedDescription)" }
        await checkCard()
    }

    func forgetCard() { bookmark.forget(); card = nil }

    // MARK: jobs

    private func run(_ first: String, _ work: @escaping @Sendable (@escaping @Sendable (JobProgress) -> Void) async throws -> String) {
        guard jobTask == nil else { return }
        job = JobProgress(first)
        jobTask = Task {
            do {
                let done = try await work { p in Task { @MainActor in if self.job != nil { self.job = p } } }
                notice = done
            } catch is CancellationError {
                notice = "Stopped."
            } catch {
                self.error = error.localizedDescription
            }
            job = nil; jobTask = nil
            await refresh()
            if let id = pendingOpen { pendingOpen = nil; await open(id) }
            await checkCard()
        }
    }

    func cancelJob() { jobTask?.cancel() }

    /// Import everything new from the card into a new tray (or `into` an existing one), then open it.
    func importFromCard(name: String, date: String, into existing: String? = nil) {
        guard let url = cardURL() else { error = "The scanner isn't connected. Plug it in and open Files once."; return }
        let library = library, renderer = renderer, learning = learningEnabled ? learning : nil
        run("Starting import") { progress in
            var trayID = existing ?? ""
            if existing == nil { trayID = try await library.createTray(name: name, date: date).id }
            let opened = trayID
            await MainActor.run { self.pendingOpen = opened }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let r = try await Importer(library: library, renderer: renderer, learning: learning).importScans(into: trayID, from: url, progress: progress)
            return r.summary
        }
    }
    /// A tray that should open as soon as its import starts showing slides.
    var pendingOpen: String?

    func upload(onlyReady: Bool) {
        guard let id = tray?.id else { return }
        guard immich.isComplete else { error = "Add your Immich server and API key in Settings first."; return }
        let library = library, settings = immich, keep = keepOriginals
        flushEdits()
        run("Connecting to Immich") { progress in
            let r = try await Uploader(library: library).finish(trayID: id, settings: settings, onlyReady: onlyReady, keepOriginals: keep, progress: progress)
            var s = "\(r.uploaded) slides uploaded to “\(r.album)”"
            if r.lost > 0 { s += "; \(r.lost) kept their Immich copy (originals deleted)" }
            return s
        }
    }

    func testImmich() async -> String {
        do {
            let c = try ImmichClient(url: immich.url, key: immich.key)
            let v = try await c.version()
            let who = try await c.whoami()
            return "Connected to Immich \(v.text) as \(who)."
        } catch {
            return error.localizedDescription
        }
    }

    // MARK: settings

    var learningEnabled: Bool {
        didSet { UserDefaults.standard.set(learningEnabled, forKey: "learningEnabled") }
    }
    var keepOriginals: Bool {
        didSet { UserDefaults.standard.set(keepOriginals, forKey: "keepOriginals") }
    }
    /// Colour settings learned from developed slides (the library's learning.json).
    @ObservationIgnored let learning: Learning.Model

    // MARK: editing

    private var pendingSave: [String: Task<Void, Never>] = [:]

    /// Change a slide locally now; save shortly after (slider drags coalesce into one write).
    /// `what` names the edit for undo (the same labels as the server: "params:warmth", "rotation"…);
    /// nil for things that aren't the photo's look (developed, skipped, date).
    func edit(_ slideID: String, what: String? = nil, debounce: Bool = false, _ change: @escaping (inout Slide) -> Void) {
        guard let trayID = tray?.id, let i = tray?.index(of: slideID) else { return }
        guard what == nil || tray?.groups[i].locked == nil else {
            error = "This slide's original scans were deleted after upload, so it can't be edited — Immich has the final version. Import its scans again to edit it."
            return
        }
        if let what { tray!.groups[i].remember(what) }
        change(&tray!.groups[i])
        save(trayID, slideID, debounce: debounce)
    }

    private func save(_ trayID: String, _ slideID: String, debounce: Bool) {
        guard let i = tray?.index(of: slideID) else { return }
        let snapshot = tray!.groups[i]
        let stock = snapshot.effectiveStock(in: tray!)
        let learnKey = "\(trayID):\(slideID)"
        pendingSave[slideID]?.cancel()
        let library = library, learning = learning, learn = learningEnabled
        pendingSave[slideID] = Task {
            if debounce { try? await Task.sleep(for: .milliseconds(300)) }
            guard !Task.isCancelled else { return }
            try? await library.update(trayID) { t in
                // write back only what the UI owns, never a stale copy of the whole tray
                if let j = t.index(of: slideID) {
                    t.groups[j].params = snapshot.params; t.groups[j].paramsSource = snapshot.paramsSource
                    t.groups[j].rotation = snapshot.rotation; t.groups[j].rotReason = snapshot.rotReason
                    t.groups[j].reviewed = snapshot.reviewed; t.groups[j].skip = snapshot.skip
                    t.groups[j].excluded = snapshot.excluded; t.groups[j].history = snapshot.history
                    t.groups[j].date = snapshot.date; t.groups[j].caption = snapshot.caption
                    if snapshot.currentMount != nil { t.groups[j].mount = snapshot.mount }   // found lazily (findMount)
                }
            }
            // learning (Python: server._learn): developed slides teach, skipped ones are forgotten
            guard learn, let f = snapshot.feat else { return }
            if snapshot.skip { learning.forget(key: learnKey) }
            else if snapshot.reviewed || snapshot.immich != nil {
                learning.remember(key: learnKey, features: f, params: snapshot.params, stock: stock)
            }
        }
    }

    func flushEdits() {}

    func setParam(_ key: WritableKeyPath<Params, Double>, _ value: Double, name: String) {
        guard let s = slide else { return }
        edit(s.id, what: "params:\(name)", debounce: true) { $0.params[keyPath: key] = value; $0.paramsSource = "manual" }
    }

    func setBalance(warmth: Double, tint: Double) {
        guard let s = slide else { return }
        edit(s.id, what: "params:tint,warmth", debounce: true) { $0.params.warmth = warmth; $0.params.tint = tint; $0.paramsSource = "manual" }
    }

    func setTrim(_ on: Bool) {
        guard let s = slide else { return }
        edit(s.id, what: "params:trim") { $0.params.trim = on; $0.paramsSource = "manual" }
    }

    func setCurves(_ curves: [String: [[Double]]]) {
        guard let s = slide else { return }
        edit(s.id, what: "params:curves", debounce: true) { $0.params.curves = Curves.clean(curves); $0.paramsSource = "manual" }
    }

    func setFrame(crop: [Double]?, angle: Double) {
        guard let s = slide else { return }
        edit(s.id, what: "params:angle,crop") { $0.params.crop = Params.cleanCrop(crop); $0.params.angle = max(-15, min(15, angle)); $0.paramsSource = "manual" }
    }

    /// Reset a group of settings to the tray's defaults (the Adjust panel's per-group reset).
    func resetParams(_ keys: [WritableKeyPath<Params, Double>]? = nil, trim: Bool = false) {
        guard let s = slide, let d = tray?.defaults else { return }
        edit(s.id, what: "reset") { g in
            if let keys { for k in keys { g.params[keyPath: k] = d[keyPath: k] }; if trim { g.params.trim = d.trim } }
            else { g.params = d; g.paramsSource = nil }
        }
    }

    /// Put the learned suggestion back (Python: resuggest).
    func useLearned() {
        guard let s = slide, let f = s.feat, let sug = learning.suggest(f, stock: tray.flatMap { s.effectiveStock(in: $0) }) else { notice = "Nothing learned for this slide yet."; return }
        edit(s.id, what: "learned") { $0.params = sug.apply(to: $0.params); $0.paramsSource = "learned:\(sug.neighbours)" }
    }

    /// "Fit to data": each colour channel's ends pulled in to the scan's data; restore off (F).
    /// `all`: every slide still to develop, each to its own data (⇧F).
    func fitCurves(all: Bool = false) {
        guard let tray else { return }
        let targets = all ? tray.groups.filter { !$0.reviewed && !$0.skip && $0.locked == nil } : (slide.map { [$0] } ?? [])
        let renderer = renderer
        Task {
            for g in targets {
                var p = g.params
                p.strength = 0
                let base = await Task.detached { () -> RGBImage? in
                    guard let a = try? renderer.fusedProxy(tray, g) else { return nil }
                    return Develop.toneBase(a.fitting(maxEdge: 900).rotated(g.rotation), p)
                }.value
                guard let base else { continue }
                let fitted = Develop.fitCurves(base, g.params.curves)
                edit(g.id, what: "fit") { $0.params.strength = 0; $0.params.curves = fitted; $0.paramsSource = "manual" }
            }
            if all { notice = "Fitted \(targets.count) slides" }
        }
    }

    /// Eyedropper: warmth and tint that make the tapped spot (0…1 of the photo) neutral.
    func neutral(at point: CGPoint) {
        guard let tray, let g = slide else { return }
        let renderer = renderer
        Task {
            let wt = await Task.detached { () -> (Double, Double)? in
                guard let a = try? renderer.fusedProxy(tray, g) else { return nil }
                return Develop.neutralBalance(a.rotated(g.rotation), g.params, x: point.x, y: point.y)
            }.value
            if let wt { setBalance(warmth: wt.0, tint: wt.1) }
        }
    }

    /// Slides imported before mount detection (or whose scans changed since) have no mount yet:
    /// look for it when the slide is shown (Python: POST …/mount).
    func findMount() {
        guard let tray, let g = slide, g.currentMount == nil, g.locked == nil else { return }
        let renderer = renderer
        Task {
            let found = await Task.detached { () -> MountEdge? in
                guard let a = try? renderer.fusedProxy(tray, g) else { return nil }
                return Develop.detectMount(a)
            }.value
            guard let found, slide?.id == g.id, slide?.activeScans == g.activeScans else { return }
            edit(g.id) { $0.mount = MountEdge(angle: found.angle, confidence: found.confidence, box: found.box, scans: g.activeScans) }
        }
    }

    /// Straighten to the mount's edge; with `trim`, also crop to its window (a tighter trim).
    func straightenToMount(trim: Bool = false) {
        guard let tray, let g = slide, let m = g.currentMount, m.confidence > 0 else { return }
        var straight = g.params
        straight.angle = m.angle == 0 ? 0 : -m.angle
        let renderer = renderer, p = straight, angle = straight.angle
        Task {
            var crop = g.params.crop
            if trim {
                crop = await Task.detached { () -> [Double]? in
                    guard let a = try? renderer.fusedProxy(tray, g) else { return nil }
                    return Develop.mountCrop(a.rotated(g.rotation), p, box: Develop.rotateBox(m.box, g.rotation))
                }.value
            }
            edit(g.id, what: "mount") { $0.params.angle = angle; $0.params.crop = crop }
        }
    }

    func undo() { step(undo: true) }
    func redo() { step(undo: false) }
    private func step(undo: Bool) {
        guard let trayID = tray?.id, let s = slide, let i = tray?.index(of: s.id), tray?.groups[i].locked == nil else { return }
        guard tray!.groups[i].step(undo: undo) != nil else { return }
        save(trayID, s.id, debounce: false)
    }

    func turn(clockwise: Bool = true) { rotate(clockwise ? 90 : 270) }
    func rotate(_ degrees: Int) {
        guard let s = slide else { return }
        edit(s.id, what: "rotation") {
            $0.rotation = ($0.rotation + degrees) % 360; $0.rotReason = "manual"
            $0.params.local = LocalAdjustment.turned($0.params.local, by: degrees)   // masks turn with the picture
        }
    }

    /// "Develop" / keep: mark ready and move on.
    func keep(advance: Bool = true) {
        guard let s = slide else { return }
        edit(s.id) { $0.reviewed = true; $0.skip = false }
        if advance { next() }
    }

    func toggleDeveloped() {
        guard let s = slide else { return }
        edit(s.id) { $0.reviewed.toggle(); if $0.reviewed { $0.skip = false } }
    }

    func skip(advance: Bool = true) {
        guard let s = slide else { return }
        edit(s.id) { $0.skip.toggle(); if $0.skip { $0.reviewed = false } }
        if advance && (tray?.groups[selection].skip ?? false) { next() }
    }

    /// Undo the last keep/skip in Simple mode: back one slide, undecided again.
    func back() {
        guard selection > 0 else { return }
        selection -= 1
        guard let s = slide else { return }
        edit(s.id) { $0.reviewed = false; $0.skip = false }
    }

    func toggleScan(_ scan: String) {
        guard let s = slide else { return }
        edit(s.id, what: "scans") { g in
            if g.excluded.contains(scan) { g.excluded.removeAll { $0 == scan } } else if g.activeScans.count > 1 { g.excluded.append(scan) }
        }
    }

    func setDate(_ date: String) {
        guard let s = slide else { return }
        let v = date.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "/", with: "-")
        edit(s.id, debounce: true) { $0.date = v.isEmpty ? nil : v }
    }

    /// Date slides `from`...`to` (indices, either order, both included) at once; "" clears theirs
    /// (Python: `POST /api/sessions/{sid}/dates`). Locked slides keep their date. Returns how many
    /// were dated, or nil when the date doesn't parse.
    @discardableResult
    func dateRange(from a: Int, to b: Int, date: String) -> Int? {
        guard let trayID = tray?.id, let t = tray, !t.groups.isEmpty else { return 0 }
        let v = date.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "/", with: "-")
        guard v.isEmpty || SlideDates.parse(v) != nil else {
            error = "Use a year, year-month or full date: 1978, 1978-06, 1978-06-14"
            return nil
        }
        let lo = max(0, min(a, b)), hi = min(t.groups.count - 1, max(a, b))
        guard lo <= hi else { return 0 }
        let ids = t.groups[lo...hi].filter { $0.locked == nil }.map(\.id)
        let value: String? = v.isEmpty ? nil : v
        for id in ids { if let i = tray?.index(of: id) { tray!.groups[i].date = value } }
        Task { try? await library.update(trayID) { t in for id in ids { if let j = t.index(of: id) { t.groups[j].date = value } } } }
        notice = (value.map { "Dated \(ids.count) slides \($0)" } ?? "Cleared the date of \(ids.count) slides") + " (\(lo + 1)–\(hi + 1))"
        return ids.count
    }

    /// Where a run dated from slide `i` naturally ends: before the next slide with its own date.
    func rangeEnd(from i: Int) -> Int {
        guard let t = tray else { return i }
        return (t.groups.indices.first { $0 > i && t.groups[$0].date != nil }).map { $0 - 1 } ?? t.groups.count - 1
    }

    func setCaption(_ caption: String) {
        guard let s = slide else { return }
        edit(s.id, debounce: true) { $0.caption = caption.isEmpty ? nil : caption }
    }

    func next() { if let t = tray { selection = min(t.groups.count, selection + 1) } }
    func previous() { selection = max(0, selection - 1) }
    func select(_ i: Int) { if let t = tray, t.groups.indices.contains(i) { selection = i } }
    /// The next slide still to develop after the current one (wrapping), for the ⇥ button.
    func nextUndeveloped() {
        guard let t = tray, !t.groups.isEmpty else { return }
        let n = t.groups.count
        for k in 1...n { let i = (selection + k) % n; if !t.groups[i].reviewed && !t.groups[i].skip { selection = i; return } }
    }

    // MARK: card cleanup

    var cleanupBlockers: [String] { tray.map(Originals.cleanupBlockers) ?? [] }

    func cleanCard() {
        guard let id = tray?.id else { return }
        guard let url = cardURL() else { error = "Plug the scanner in to clean its card."; return }
        let library = library
        run("Cleaning the card") { progress in
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            return try await Originals.cleanCard(trayID: id, card: url, library: library, progress: progress).summary
        }
    }
}

/// Rendered previews, keyed by what they show, so going back to a slide is instant.
@MainActor
final class PreviewCache {
    let renderer: Renderer
    private var images: [String: UIImage] = [:]
    private var order: [String] = []

    init(renderer: Renderer) { self.renderer = renderer }

    static func key(_ slide: Slide, edge: Int, before: Bool, crop: Bool = true) -> String {
        // the uncropped view (crop tool) doesn't change with the crop itself
        var p = slide.params
        if !crop { p.crop = nil }
        var s = slide; s.params = p
        return "\(slide.id)|\(s.renderKey)|\(edge)|\(before)|\(crop)"
    }

    func cached(_ slide: Slide, edge: Int, before: Bool = false, crop: Bool = true) -> UIImage? { images[Self.key(slide, edge: edge, before: before, crop: crop)] }

    func image(_ tray: Tray, _ slide: Slide, edge: Int, before: Bool = false, crop: Bool = true) async -> UIImage? {
        let key = Self.key(slide, edge: edge, before: before, crop: crop)
        if let hit = images[key] { return hit }
        let renderer = renderer
        let cg = await Task.detached(priority: .userInitiated) { () -> CGImage? in
            guard let img = try? renderer.preview(tray, slide, maxEdge: edge, before: before, crop: crop) else { return nil }
            return ImageFile.cgImage(img)
        }.value
        guard let cg else { return nil }
        let ui = UIImage(cgImage: cg)
        images[key] = ui
        order.append(key)
        while order.count > 160 { images[order.removeFirst()] = nil }
        return ui
    }
}
