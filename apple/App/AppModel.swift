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
        immich = ImmichSettings(url: UserDefaults.standard.string(forKey: "immichURL") ?? "", key: Keychain.get("immichKey") ?? "")
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
        let library = library, renderer = renderer
        run("Starting import") { progress in
            var trayID = existing ?? ""
            if existing == nil { trayID = try await library.createTray(name: name, date: date).id }
            let opened = trayID
            await MainActor.run { self.pendingOpen = opened }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let r = try await Importer(library: library, renderer: renderer).importScans(into: trayID, from: url, progress: progress)
            return r.summary
        }
    }
    /// A tray that should open as soon as its import starts showing slides.
    var pendingOpen: String?

    func upload(onlyReady: Bool) {
        guard let id = tray?.id else { return }
        guard immich.isComplete else { error = "Add your Immich server and API key in Settings first."; return }
        let library = library, settings = immich
        flushEdits()
        run("Connecting to Immich") { progress in
            let r = try await Uploader(library: library).finish(trayID: id, settings: settings, onlyReady: onlyReady, progress: progress)
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

    // MARK: editing

    private var pendingSave: [String: Task<Void, Never>] = [:]

    /// Change a slide locally now; save shortly after (slider drags coalesce into one write).
    func edit(_ slideID: String, debounce: Bool = false, _ change: @escaping (inout Slide) -> Void) {
        guard let trayID = tray?.id, let i = tray?.index(of: slideID) else { return }
        guard tray?.groups[i].locked == nil else { error = "This slide's originals are gone; it can't be edited."; return }
        change(&tray!.groups[i])
        let snapshot = tray!.groups[i]
        pendingSave[slideID]?.cancel()
        let library = library
        pendingSave[slideID] = Task {
            if debounce { try? await Task.sleep(for: .milliseconds(300)) }
            guard !Task.isCancelled else { return }
            try? await library.update(trayID) { t in
                // write back only what the UI owns, never a stale copy of the whole tray
                if let j = t.index(of: slideID) {
                    t.groups[j].params = snapshot.params; t.groups[j].paramsSource = snapshot.paramsSource
                    t.groups[j].rotation = snapshot.rotation; t.groups[j].rotReason = snapshot.rotReason
                    t.groups[j].reviewed = snapshot.reviewed; t.groups[j].skip = snapshot.skip
                    t.groups[j].excluded = snapshot.excluded
                    t.groups[j].date = snapshot.date; t.groups[j].caption = snapshot.caption
                }
            }
        }
    }

    func flushEdits() {
        // debounced saves are short; nothing to do but let them run — kept as a hook for undo later
    }

    func setParam(_ key: WritableKeyPath<Params, Double>, _ value: Double) {
        guard let s = slide else { return }
        edit(s.id, debounce: true) { $0.params[keyPath: key] = value; $0.paramsSource = "manual" }
    }

    func setTrim(_ on: Bool) {
        guard let s = slide else { return }
        edit(s.id) { $0.params.trim = on; $0.paramsSource = "manual" }
    }

    func resetParams() {
        guard let s = slide, let d = tray?.defaults else { return }
        edit(s.id) { $0.params = d; $0.paramsSource = nil }
    }

    func turn(clockwise: Bool = true) {
        guard let s = slide else { return }
        edit(s.id) { $0.rotation = ($0.rotation + (clockwise ? 90 : 270)) % 360; $0.rotReason = "manual" }
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
        edit(s.id) { g in
            if g.excluded.contains(scan) { g.excluded.removeAll { $0 == scan } } else if g.activeScans.count > 1 { g.excluded.append(scan) }
        }
    }

    func setDate(_ date: String) {
        guard let s = slide else { return }
        let v = date.trimmingCharacters(in: .whitespaces)
        edit(s.id, debounce: true) { $0.date = v.isEmpty ? nil : v }
    }

    func setCaption(_ caption: String) {
        guard let s = slide else { return }
        edit(s.id, debounce: true) { $0.caption = caption.isEmpty ? nil : caption }
    }

    func next() { if let t = tray { selection = min(t.groups.count, selection + 1) } }
    func previous() { selection = max(0, selection - 1) }
    func select(_ i: Int) { if let t = tray, t.groups.indices.contains(i) { selection = i } }
}

/// Rendered previews, keyed by what they show, so going back to a slide is instant.
@MainActor
final class PreviewCache {
    let renderer: Renderer
    private var images: [String: UIImage] = [:]
    private var order: [String] = []

    init(renderer: Renderer) { self.renderer = renderer }

    static func key(_ slide: Slide, edge: Int, before: Bool) -> String { "\(slide.id)|\(slide.renderKey)|\(edge)|\(before)" }

    func cached(_ slide: Slide, edge: Int, before: Bool = false) -> UIImage? { images[Self.key(slide, edge: edge, before: before)] }

    func image(_ tray: Tray, _ slide: Slide, edge: Int, before: Bool = false) async -> UIImage? {
        let key = Self.key(slide, edge: edge, before: before)
        if let hit = images[key] { return hit }
        let renderer = renderer
        let cg = await Task.detached(priority: .userInitiated) { () -> CGImage? in
            guard let img = try? renderer.preview(tray, slide, maxEdge: edge, before: before) else { return nil }
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
