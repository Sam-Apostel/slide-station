import Foundation

public struct JobProgress: Sendable, Equatable {
    public var message: String
    public var done: Int
    public var total: Int
    public var fraction: Double { total > 0 ? Double(done) / Double(total) : 0 }
    public init(_ message: String, done: Int = 0, total: Int = 0) { self.message = message; self.done = done; self.total = total }
}

public struct ImportResult: Sendable, Equatable {
    public var imported = 0, slides = 0, skipped = 0, restored = 0
    public var summary: String {
        var s = "Imported \(imported) scans into \(slides) slides"
        if skipped > 0 { s += " (\(skipped) were already imported)" }
        if restored > 0 { s += "; restored \(restored) deleted originals" }
        return s
    }
}

/// Copy scans off the card into a tray, verify every copy, then group, pick the best of each
/// bracket and guess rotations — `workflow.import_scans` in Swift.
public struct Importer: Sendable {
    public let library: Library
    public let renderer: Renderer
    /// Suggests settings for new slides from developed ones (nil: learning off).
    public var learning: Learning.Model?

    public init(library: Library, renderer: Renderer, learning: Learning.Model? = nil) {
        self.library = library; self.renderer = renderer; self.learning = learning
    }

    /// `source` must already be accessible (security scope started by the caller).
    public func importScans(into trayID: String, from source: URL, progress: @Sendable (JobProgress) -> Void = { _ in }) async throws -> ImportResult {
        let fm = FileManager.default
        let removable = CardSource.hasDCIM(source)   // only a card itself may ever be cleaned up later
        var files = CardSource.jpegs(in: source)
        let taken = Dictionary(uniqueKeysWithValues: files.map { ($0, Importer.taken($0)) })
        files.sort { (taken[$0]!, $0.lastPathComponent) < (taken[$1]!, $1.lastPathComponent) }

        var tray = try await library.load(trayID)
        let index = await library.importedIndex()
        var result = ImportResult()
        var newIDs: [String] = [], records: [String: ScanRecord] = [:]
        var fpIndex: [String: String] = [:], shaIndex: [String: String] = [:]
        let originals = library.originals(trayID)
        try fm.createDirectory(at: originals, withIntermediateDirectories: true)
        try fm.createDirectory(at: library.cacheDir(trayID), withIntermediateDirectories: true)

        for (n, f) in files.enumerated() {
            progress(JobProgress("Copying \(files.count) scans", done: n, total: files.count))
            try Task.checkCancellation()
            // always by content: the quick fingerprint (name+size+mtime) only estimates "new" on
            // the card, and a different scan can share it (the scanner restarting its numbering)
            let fp = CardSource.quickFingerprint(f)
            let sha = try sha1(of: f)
            if index.sha[sha] != nil || shaIndex[sha] != nil {
                // already imported — but if this tray lost that original, put it back (unlocks it)
                for (_, rec) in tray.scans where rec.sha1 == sha {
                    let dest = originals.appendingPathComponent(rec.file)
                    if !fm.fileExists(atPath: dest.path) {
                        try fm.copyItem(at: f, to: dest)
                        guard try sha1(of: dest) == sha else { try? fm.removeItem(at: dest); throw SlideKitError.verifyFailed(f.lastPathComponent) }
                        result.restored += 1
                    }
                }
                result.skipped += 1
                if let fp { fpIndex[fp] = sha }
                continue
            }
            let scanID = "\(f.deletingPathExtension().lastPathComponent)_\(sha.prefix(6))"
            let dest = originals.appendingPathComponent("\(scanID).jpg")
            if fm.fileExists(atPath: dest.path) { try fm.removeItem(at: dest) }
            try fm.copyItem(at: f, to: dest)
            guard try sha1(of: dest) == sha else { try? fm.removeItem(at: dest); throw SlideKitError.verifyFailed(f.lastPathComponent) }
            let size = (try? fm.attributesOfItem(atPath: f.path)[.size] as? Int) ?? 0
            // resolved paths on both sides (/var vs /private/var), so the scan's place below the
            // card's root can be found again when cleaning the card
            records[scanID] = ScanRecord(file: dest.lastPathComponent, source: f.resolvingSymlinksInPath().path,
                                         sourceRoot: source.resolvingSymlinksInPath().path, removable: removable,
                                         size: size, sha1: sha, taken: taken[f]!)
            newIDs.append(scanID)
            if let fp { fpIndex[fp] = sha }
            shaIndex[sha] = trayID
        }
        tray = try await library.update(trayID) { $0.scans.merge(records) { _, new in new } }
        // recorded straight after copying, so a crash can't cause double imports
        try await library.addToIndex(sha: shaIndex, fp: fpIndex)
        result.imported = newIDs.count

        // scans copied by an import that stopped before grouping them (a crash, the app killed):
        // the dedupe index skips them from now on, so they are grouped here, in their place
        let grouped = Set(tray.groups.flatMap(\.scans))
        let stranded = tray.scans.keys.filter { !grouped.contains($0) && !newIDs.contains($0) }
        if !stranded.isEmpty {
            newIDs = (newIDs + stranded).sorted {
                let a = tray.scans[$0]?.taken ?? "", b = tray.scans[$1]?.taken ?? ""
                return a == b ? $0 < $1 : a < b
            }
        }

        // signatures for grouping
        var sigs: [String: [Float]] = [:]
        for (n, id) in newIDs.enumerated() {
            progress(JobProgress("Analysing scans", done: n, total: newIDs.count))
            try Task.checkCancellation()
            sigs[id] = try renderer.signature(tray, scan: id)
        }

        // group, continuing the last slide if the first new scan is another exposure of it
        let last = tray.groups.last
        var previous: [[Float]]?
        if let last, last.immich == nil, !newIDs.isEmpty { previous = try last.scans.map { try renderer.signature(tray, scan: $0) } }
        let (groups, continues) = Brackets.groupSequence(newIDs.map { sigs[$0]! }, previous: previous)
        result.slides = groups.count - (continues ? 1 : 0)

        for (k, ig) in groups.enumerated() {
            progress(JobProgress("Blending brackets and guessing rotations", done: k, total: groups.count))
            try Task.checkCancellation()
            let ids = ig.map { newIDs[$0] }
            let extend = k == 0 && continues
            var g = extend ? last! : Slide(scans: ids, params: tray.defaults)
            if extend { g.scans += ids }
            // best of the bracket: leave out blurry or almost entirely clipped scans (1–9 puts them back)
            if g.scans.count > 1 && !g.developed {
                let q = try g.scans.map { Brackets.quality(try renderer.proxy(tray, scan: $0)) }
                let autoOut = Dictionary(uniqueKeysWithValues: Brackets.weakScans(q).map { (g.scans[$0.key], $0.value) })
                let manualIn = Set((g.autoExcluded ?? [:]).keys).subtracting(g.excluded)
                g.excluded = Set(g.excluded).union(Set(autoOut.keys).subtracting(manualIn)).sorted()
                g.autoExcluded = autoOut
            }
            var rot: (Int, String)?
            if !g.developed && g.rotReason != "manual" {
                rot = Brackets.suggestRotation(try g.activeScans.map { try renderer.proxy(tray, scan: $0) })
            }
            let fused = try renderer.fusedProxy(tray, g)   // pre-blend the bracket so browsing is instant
            let feats = Learning.features(fused, scans: g.activeScans.count)
            let found = Develop.detectMount(fused)
            let mount = MountEdge(angle: found.angle, confidence: found.confidence, box: found.box, scans: g.activeScans)
            let suggestion = learning?.suggest(feats, stock: g.effectiveStock(in: tray))
            let slide = g
            tray = try await library.update(trayID) { fresh in
                var target: Slide
                if extend, let i = fresh.index(of: slide.id) {
                    fresh.groups[i].scans = slide.scans
                    fresh.groups[i].excluded = slide.excluded; fresh.groups[i].autoExcluded = slide.autoExcluded
                    target = fresh.groups[i]
                } else {
                    target = slide
                    target.params = fresh.defaults
                }
                if let rot, rot.1 != "", target.rotReason != "manual" { target.rotation = rot.0; target.rotReason = rot.1 }
                target.feat = feats
                target.mount = mount
                // straighten to the mount by itself only when very sure (otherwise the Frame section offers it)
                if !extend && target.straightensToMount { target.params.angle = -mount.angle }
                if let suggestion, !target.developed, target.paramsSource != "manual" {
                    target.params = suggestion.apply(to: target.params)
                    target.paramsSource = "learned:\(suggestion.neighbours)"
                }
                if let i = fresh.index(of: target.id) { fresh.groups[i] = target } else { fresh.groups.append(target) }
            }
        }
        if result.restored > 0 { try await Originals.syncLocks(trayID: trayID, library: library) }
        let summary = result
        try await library.update(trayID) { $0.appendLog("\(summary.summary) from \(source.lastPathComponent)") }
        progress(JobProgress(result.summary, done: 1, total: 1))
        return result
    }

    /// The scan's EXIF time, or its modification time — for ordering, never for dating.
    static func taken(_ url: URL) -> String {
        let dt = ImageFile.info(url).dateTime
        if !dt.isEmpty { return dt }
        let m = (try? FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date) ?? Date()
        let f = DateFormatter()
        f.dateFormat = "yyyy:MM:dd HH:mm:ss"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f.string(from: m)
    }
}
