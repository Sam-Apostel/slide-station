import Foundation

/// Card cleanup and local originals — `workflow.cleanup_card`, `sync_locks`, `_drop_local_originals`.
///
/// Safety rules carried over unchanged (ARCHITECTURE.md §3, "do not weaken"): only scans imported
/// from a card (a folder with DCIM at its root) are ever deleted; every file is re-hashed against
/// the stored SHA-1 immediately before deletion; cleanup is blocked until every slide is uploaded
/// or skipped.
public enum Originals {
    // MARK: card cleanup

    public static func cleanupBlockers(_ tray: Tray) -> [String] {
        var problems: [String] = []
        let st = tray.statuses()
        let pending = st.indices.filter { st[$0] != .uploaded && st[$0] != .skipped }
        if let first = pending.first { problems.append("\(pending.count) slide\(pending.count == 1 ? "" : "s") not in Immich yet (e.g. #\(first + 1))") }
        if !tray.scans.values.contains(where: \.removable) { problems.append("these scans were imported from a folder, not from the scanner's card") }
        return problems
    }

    /// Where a scan is on the card now. iPadOS may mount the card at a different path each time, so
    /// the path is rebuilt from the part below the card's root.
    static func location(of scan: ScanRecord, card: URL) -> URL? {
        guard scan.source.hasPrefix(scan.sourceRoot) else { return nil }
        let rel = scan.source.dropFirst(scan.sourceRoot.count).drop { $0 == "/" }
        return rel.isEmpty ? nil : card.appendingPathComponent(String(rel))
    }

    public struct CleanupResult: Sendable, Equatable {
        public var deleted = 0, missing = 0, mismatched = 0
        public var summary: String {
            var s = "Deleted \(deleted) scans from the card"
            if missing > 0 { s += ", \(missing) were already gone" }
            if mismatched > 0 { s += ", left \(mismatched) that didn't match" }
            return s
        }
    }

    /// Delete this tray's scans from the card — only files that still match the verified copy.
    /// `card` must be accessible (security scope started by the caller).
    public static func cleanCard(trayID: String, card: URL, library: Library,
                                 progress: @Sendable (JobProgress) -> Void = { _ in }) async throws -> CleanupResult {
        let tray = try await library.load(trayID)
        let blockers = cleanupBlockers(tray)
        guard blockers.isEmpty else { throw SlideKitError.immich("Not cleaning the card: " + blockers.joined(separator: "; ")) }
        let fm = FileManager.default
        let scans = tray.scans.filter { $0.value.removable && !$0.value.sourceDeleted }.sorted { $0.key < $1.key }
        var r = CleanupResult(), done: [String] = []
        for (n, (id, sc)) in scans.enumerated() {
            try Task.checkCancellation()
            progress(JobProgress("Cleaning the card", done: n, total: scans.count))
            // a scan we can't place on this card is left alone, never assumed gone
            guard let url = location(of: sc, card: card) else { r.mismatched += 1; continue }
            guard fm.fileExists(atPath: url.path) else { r.missing += 1; done.append(id); continue }
            let size = (try? fm.attributesOfItem(atPath: url.path)[.size] as? Int) ?? -1
            guard size == sc.size, (try? sha1(of: url)) == sc.sha1 else { r.mismatched += 1; continue }  // a different photo now: leave it
            try fm.removeItem(at: url)
            done.append(id); r.deleted += 1
        }
        let result = r
        try await library.update(trayID) { t in
            for id in done { t.scans[id]?.sourceDeleted = true }
            t.cardCleaned = result.mismatched == 0
            t.appendLog("Card cleanup: deleted \(result.deleted), not found \(result.missing), left alone \(result.mismatched)")
        }
        return r
    }

    // MARK: local originals

    /// With "keep originals" off: once every slide is in Immich or skipped, delete the tray's
    /// original scans (the proxies stay for previews) and lock the slides that used them.
    public static func dropLocalOriginals(trayID: String, library: Library) async throws -> Bool {
        let tray = try await library.load(trayID)
        guard tray.groups.allSatisfy({ [.uploaded, .skipped].contains(Tray.status($0)) }) else { return false }
        for sc in tray.scans.values { try? FileManager.default.removeItem(at: library.originals(trayID).appendingPathComponent(sc.file)) }
        try await syncLocks(trayID: trayID, library: library)
        return true
    }

    public static func originalsMissing(_ tray: Tray, _ g: Slide, library: Library) -> Bool {
        g.activeScans.contains { id in library.originalURL(tray, scan: id).map { !FileManager.default.fileExists(atPath: $0.path) } ?? true }
    }

    /// Lock slides whose originals are gone (they can't be rendered again, so not edited); unlock
    /// them when the originals are back (a re-import restores them).
    @discardableResult
    public static func syncLocks(trayID: String, library: Library) async throws -> Bool {
        var changed = false
        try await library.update(trayID) { t in
            let snapshot = t
            for i in t.groups.indices {
                let missing = originalsMissing(snapshot, t.groups[i], library: library)
                if missing && t.groups[i].locked == nil { t.groups[i].locked = "originals"; changed = true }
                if !missing && t.groups[i].locked != nil { t.groups[i].locked = nil; changed = true }
            }
        }
        return changed
    }
}
