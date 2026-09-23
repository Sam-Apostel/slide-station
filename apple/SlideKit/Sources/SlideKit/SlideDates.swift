import Foundation

public struct SlideDate: Equatable, Sendable {
    public enum Source: String, Sendable { case own, between, near, tray, scan }
    public var value: String   // "1978", "1978-06" or "1978-06-14"; empty = use the scan's EXIF
    public var source: Source
}

/// Dates as the Python app estimates them (`store.slide_dates`): a slide's own date wins; others
/// are interpolated between the dated slides around them in tray order, then the nearest dated
/// one, then the tray's date.
public enum SlideDates {
    /// "1978", "1978-06" or "1978-06-14" (or with slashes) -> (start of that period, precision 1...3).
    public static func parse(_ v: String?) -> (Date, Int)? {
        guard let v = v?.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "/", with: "-"), !v.isEmpty else { return nil }
        let parts = v.split(separator: "-", omittingEmptySubsequences: false)
        guard (1...3).contains(parts.count), parts[0].count == 4, let y = Int(parts[0]) else { return nil }
        var ints = [y]
        for p in parts.dropFirst() {
            guard (1...2).contains(p.count), let n = Int(p) else { return nil }
            ints.append(n)
        }
        var c = DateComponents()
        c.year = y; c.month = max(1, min(12, ints.count > 1 ? ints[1] : 1)); c.day = max(1, min(31, ints.count > 2 ? ints[2] : 1))
        guard let date = calendar.date(from: c), calendar.component(.day, from: date) == c.day else { return nil }
        return (date, ints.count)
    }

    public static func format(_ d: Date, precision: Int) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: d)
        switch precision {
        case 1: return String(format: "%04d", c.year!)
        case 2: return String(format: "%04d-%02d", c.year!, c.month!)
        default: return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
        }
    }

    public static func estimate(_ tray: Tray) -> [SlideDate] {
        let own = tray.groups.map { parse($0.date) }
        let dated = own.indices.filter { own[$0] != nil }
        let trayDate = parse(tray.date)
        return tray.groups.indices.map { i in
            if let o = own[i] { return SlideDate(value: format(o.0, precision: o.1), source: .own) }
            let before = dated.last { $0 < i }, after = dated.first { $0 > i }
            if let b = before, let a = after, let (t0, p0) = own[b], let (t1, p1) = own[a] {
                let t = t0.addingTimeInterval(t1.timeIntervalSince(t0) * Double(i - b) / Double(a - b))
                return SlideDate(value: format(t, precision: min(p0, p1)), source: .between)
            }
            if let j = before ?? after, let (t, p) = own[j] { return SlideDate(value: format(t, precision: p), source: .near) }
            if let (t, p) = trayDate { return SlideDate(value: format(t, precision: p), source: .tray) }
            return SlideDate(value: "", source: .scan)
        }
    }

    static let calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }()
}
