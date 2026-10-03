import Foundation
import Observation
import ProUI
import SlideFaces
import SlideKit
import SwiftUI

/// People on your own slides (the desktop app's People, `people.py`): faces found on each slide
/// with the desktop's own models, grouped into people across the library, named once. The same
/// faces.json and people.json as the desktop app, so a library shared with it keeps its people.
@MainActor @Observable
final class PeopleModel {
    private(set) var files: FaceFiles
    private(set) var finder: FaceFinder
    private(set) var people: People
    @ObservationIgnored private var library: Library
    @ObservationIgnored private var renderer: Renderer

    /// people.json as last read (nil: not read yet).
    private(set) var file: People.File?
    /// Bumped when faces.json files change, so views showing faces look again.
    private(set) var generation = 0

    /// Settings → "Recognise people" (the desktop's `people_enabled`).
    var enabled: Bool {
        didSet { UserDefaults.standard.set(enabled, forKey: "peopleEnabled") }
    }
    var modelReady: Bool { finder.modelReady }

    /// The face picked on the slide (outlined on the photo, its picker open).
    var picked: String?
    /// "Mark someone it missed": the next tap on the photo marks a face there.
    var marking = false

    init(library: Library, renderer: Renderer) {
        self.library = library
        self.renderer = renderer
        let root = library.root
        let files = FaceFiles(root: root)
        self.files = files
        finder = FaceFinder(files: files)
        people = People(files: files, order: PeopleModel.order(root))
        enabled = UserDefaults.standard.bool(forKey: "peopleEnabled")
    }

    /// A tray's slide ids in order, read from its session.json (for "nearby" slides).
    nonisolated static func order(_ root: URL) -> @Sendable (String) -> [String] {
        { tray in
            let url = root.appendingPathComponent("sessions/\(tray)/session.json")
            guard let d = try? Data(contentsOf: url), case .array(let groups)? = (try? JSONValue.parse(d))?["groups"] else { return [] }
            return groups.compactMap { if case .string(let s)? = $0["id"] { return s }; return nil }
        }
    }

    /// Another library (Settings → Library): its own people.
    func use(library: Library, renderer: Renderer) {
        self.library = library; self.renderer = renderer
        let root = library.root
        let files = FaceFiles(root: root)
        self.files = files
        finder = FaceFinder(files: files)
        people = People(files: files, order: PeopleModel.order(root))
        file = nil; picked = nil; marking = false
        Task { await reload() }
    }

    func reload() async {
        let people = people
        file = await Task.detached { try? people.refresh() }.value
        generation += 1
    }

    // MARK: finding faces

    /// Slides of `tray` whose faces need looking at (not yet, or since turned / re-stacked).
    nonisolated func stale(_ tray: Tray, finder: FaceFinder) -> [Slide] {
        tray.groups.filter { finder.stale(tray: tray.id, slide: $0) && $0.locked == nil }
    }

    /// Download the model if it isn't there, then find the faces on these trays' slides that need it.
    /// Runs inside a job (`progress`); answers what it did.
    nonisolated func find(trays: [Tray], finder: FaceFinder, people: People, renderer: Renderer,
                          progress: @escaping @Sendable (JobProgress) -> Void) async throws -> String {
        if !finder.modelReady {
            try await finder.downloadModel { done, total in progress(JobProgress("Downloading the face model", done: done, total: total)) }
        }
        let todo = trays.flatMap { t in stale(t, finder: finder).map { (t, $0) } }
        var faces = 0
        for (n, (tray, g)) in todo.enumerated() {
            try Task.checkCancellation()
            progress(JobProgress("Finding faces", done: n, total: todo.count))
            guard let proxy = try? renderer.fusedProxy(tray, g) else { continue }
            faces += try finder.record(tray: tray.id, slide: g, rgb: proxy.oriented(g.rotation, mirror: g.mirror)).count
        }
        try people.refresh()
        try people.spread(trays: trays.map(\.id))
        return todo.isEmpty ? "Every face is found already" : "Found \(faces) faces on \(todo.count) slides"
    }

    /// One slide, right away (the People tool on a slide not looked at yet).
    func findOnSlide(_ tray: Tray, _ g: Slide) async {
        guard enabled, modelReady, finder.stale(tray: tray.id, slide: g) else { return }
        let finder = finder, renderer = renderer, people = people
        await Task.detached {
            guard let proxy = try? renderer.fusedProxy(tray, g) else { return }
            _ = try? finder.record(tray: tray.id, slide: g, rgb: proxy.oriented(g.rotation, mirror: g.mirror))
            _ = try? people.refresh()
            _ = try? people.spread(trays: [tray.id])
        }.value
        await reload()
    }

    // MARK: a slide's faces

    struct SlideFace: Identifiable, Equatable {
        let face: StoredFace
        let person: String?
        let label: String?   // their name; nil = nobody named yet
        var id: String { face.id }
    }

    /// The faces on a slide, left to right, with who they are; ignored people's faces left out.
    func faces(_ tray: Tray, _ g: Slide) -> [SlideFace] {
        _ = generation
        return files.faces(tray: tray.id, slide: g.id).sorted { $0.box[0] < $1.box[0] }.compactMap { f in
            let pid = file?.owner(of: f.id)
            if let pid, file?.ignored(pid) ?? false { return nil }
            let name = pid.flatMap { file?.name($0) }.flatMap { $0.isEmpty ? nil : $0 }
            return SlideFace(face: f, person: pid, label: name)
        }
    }

    /// Named people for the picker, likeliest first (`/api/people/names?face=`).
    func names(for face: String, matching text: String = "") -> [(pid: String, name: String, likely: Bool)] {
        guard let d = file else { return [] }
        let score = people.likely(face, d)
        let words = text.lowercased().split(separator: " ")
        return d.ids.filter { d.known($0) && !d.ignored($0) && score[$0] != -1 }
            .filter { pid in words.isEmpty || words.allSatisfy { w in d.label(pid).lowercased().split(separator: " ").contains { $0.hasPrefix(w) } } }
            .sorted { (score[$0] ?? 0, d.label($1)) > (score[$1] ?? 0, d.label($0)) }
            .map { ($0, d.label($0), (score[$0] ?? 0) >= Double(FaceRules.samePerson)) }
    }

    /// Faces by id (for the People screen), as stored.
    func stored(_ ids: [String]) -> [StoredFace] {
        _ = generation
        let all = files.allFaces()
        return ids.compactMap { all[$0] }
    }

    // MARK: edits (each saves, then reads people.json again)

    private func edit(_ what: @escaping @Sendable (People) throws -> People.File, failed: @escaping (String) -> Void) {
        let people = people
        Task {
            do { file = try await Task.detached { try what(people) }.value; generation += 1 }
            catch { failed(error.localizedDescription) }
        }
    }

    func assign(_ face: String, to: People.Target, failed: @escaping (String) -> Void) { edit({ try $0.assign(face, to: to) }, failed: failed) }
    func rename(_ pid: String, _ name: String, failed: @escaping (String) -> Void) { edit({ try $0.rename(pid, name) }, failed: failed) }
    func setBirthday(_ pid: String, _ v: String, failed: @escaping (String) -> Void) { edit({ try $0.setBirthday(pid, v) }, failed: failed) }
    func merge(into: String, _ others: [String], failed: @escaping (String) -> Void) { edit({ try $0.merge(into: into, others) }, failed: failed) }
    func remove(_ pid: String, faces: [String], failed: @escaping (String) -> Void) { edit({ try $0.remove(pid, faces: faces) }, failed: failed) }
    func setIgnored(_ pids: [String], _ on: Bool, failed: @escaping (String) -> Void) { edit({ try $0.setIgnored(pids, on) }, failed: failed) }

    /// Someone the finder missed, at a point of the upright slide (0...1).
    func mark(_ tray: Tray, _ g: Slide, at point: CGPoint, failed: @escaping (String) -> Void) {
        let finder = finder, renderer = renderer, people = people
        marking = false
        Task {
            do {
                let id = try await Task.detached { () throws -> String in
                    let proxy = try renderer.fusedProxy(tray, g)
                    let id = try finder.mark(tray: tray.id, slide: g, rgb: proxy.oriented(g.rotation, mirror: g.mirror), point: point)
                    try people.refresh()
                    return id
                }.value
                await reload()
                picked = id
            } catch { failed(error.localizedDescription) }
        }
    }

    /// Nobody there after all (a face marked by hand).
    func drop(_ face: String) {
        let finder = finder
        Task { try? await Task.detached { try finder.drop(face: face) }.value; picked = nil; await reload() }
    }

    // MARK: face pictures

    @ObservationIgnored private var crops: [String: CGImage] = [:]
    @ObservationIgnored private var cropOrder: [String] = []
    @ObservationIgnored private var proxies: [String: RGBImage] = [:]

    func cachedCrop(_ f: StoredFace) -> CGImage? { crops[f.id + f.box.description] }

    /// A square around a face (`people.face_crop`: 1.6 × its longer side), from the slide as turned.
    func crop(_ f: StoredFace) async -> CGImage? {
        let key = f.id + f.box.description
        if let hit = crops[key] { return hit }
        guard let tray = try? await library.load(f.tray), let g = tray.groups.first(where: { $0.id == f.slide }) else { return nil }
        let pkey = "\(tray.id)/\(g.id)/\(g.faceKey)"
        let renderer = renderer, cached = proxies[pkey]
        let result = await Task.detached { () -> (RGBImage, CGImage?)? in
            guard let upright = cached ?? (try? renderer.fusedProxy(tray, g))?.oriented(g.rotation, mirror: g.mirror) else { return nil }
            let w = Double(upright.width), h = Double(upright.height)
            let cx = (f.box[0] + f.box[2] / 2) * w, cy = (f.box[1] + f.box[3] / 2) * h
            let half = max(f.box[2] * w, f.box[3] * h) * 0.8
            let x0 = Int(max(0, cx - half)), x1 = Int(min(w, cx + half)), y0 = Int(max(0, cy - half)), y1 = Int(min(h, cy + half))
            let c = upright.cropped(top: y0, bottom: max(y1, y0 + 1), left: x0, right: max(x1, x0 + 1)).resized(width: 160, height: 160)
            return (upright, ImageFile.cgImage(c))
        }.value
        guard let (upright, img) = result, let img else { return nil }
        proxies = [pkey: upright]   // the slide in view, for its other faces
        crops[key] = img
        cropOrder.append(key)
        while cropOrder.count > 400 { crops[cropOrder.removeFirst()] = nil }
        return img
    }
}

/// A face, round, cut from its slide.
struct FaceImage: View {
    @Environment(AppModel.self) private var model
    let face: StoredFace
    var size: CGFloat = 52
    @State private var image: CGImage?

    var body: some View {
        ZStack {
            Circle().fill(SS.panel2)
            if let image = model.people.cachedCrop(face) ?? image { Image(decorative: image, scale: 1).resizable().scaledToFill() }
            else { Image(systemName: "person.fill").foregroundStyle(ProTheme.dim) }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .task(id: face.id + face.box.description) { image = await model.people.crop(face) }
    }
}
