import Foundation

/// An Immich album this account can see: its own, or one someone shared with it.
public struct ImmichAlbum: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var count: Int
    /// The asset Immich shows as the album's cover.
    public var coverID: String?
    /// Whoever shared it, when it isn't this account's own (nil for one's own albums).
    public var sharedBy: String?
    public var updated: Date?

    public init(id: String, name: String, count: Int, coverID: String? = nil, sharedBy: String? = nil, updated: Date? = nil) {
        self.id = id; self.name = name; self.count = count; self.coverID = coverID; self.sharedBy = sharedBy; self.updated = updated
    }

    /// From `GET /albums` (v1 through v3). `me`: this account's user id, to tell shared albums apart.
    init?(json o: [String: Any], me: String?) {
        guard let id = o["id"] as? String else { return nil }
        self.id = id
        name = (o["albumName"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled album"
        count = o["assetCount"] as? Int ?? 0
        coverID = o["albumThumbnailAssetId"] as? String
        let owner = o["owner"] as? [String: Any]
        let ownerID = (owner?["id"] as? String) ?? (o["ownerId"] as? String)
        if let ownerID, let me, ownerID != me {
            sharedBy = (owner?["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (owner?["email"] as? String) ?? "someone"
        }
        updated = (o["updatedAt"] as? String).flatMap(ImmichDate.instant)
    }
}

/// Someone Immich recognised in a photo, and where: the face as fractions of the photo
/// (x1, y1, x2, y2), so an avatar can be cut from any size of it.
public struct PhotoPerson: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var box: [Double]
    public init(id: String, name: String, box: [Double]) { self.id = id; self.name = name; self.box = box }

    /// From an asset's `people` (PersonWithFacesResponseDto): one entry per face.
    static func list(_ raw: Any?) -> [PhotoPerson] {
        (raw as? [[String: Any]] ?? []).flatMap { p -> [PhotoPerson] in
            guard let id = p["id"] as? String else { return [] }
            let name = (p["name"] as? String ?? "").trimmingCharacters(in: .whitespaces)
            if p["isHidden"] as? Bool == true { return [] }
            return (p["faces"] as? [[String: Any]] ?? []).compactMap { f in
                func n(_ k: String) -> Double? { (f[k] as? NSNumber)?.doubleValue }
                guard let w = n("imageWidth"), let h = n("imageHeight"), w > 0, h > 0,
                      let x1 = n("boundingBoxX1"), let y1 = n("boundingBoxY1"), let x2 = n("boundingBoxX2"), let y2 = n("boundingBoxY2") else { return nil }
                return PhotoPerson(id: id, name: name, box: [x1 / w, y1 / h, x2 / w, y2 / h])
            }
        }
    }
}

/// A photo in an album, with what Slide Station wrote into it: the caption (Immich's description),
/// the date and the place.
public struct AlbumPhoto: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var albumID: String
    /// The wall-clock date and time (Immich's `localDateTime`), kept in UTC so it never shifts.
    public var taken: Date?
    public var caption: String?
    public var place: String?
    public var width: Int?
    public var height: Int?
    /// The file name it was uploaded with ("slide-12.jpg"), for saving a copy.
    public var filename: String?
    /// The account that owns it: only the owner can make it a favorite (others like it instead).
    public var owner: String?
    /// Starred: Immich's favorite on one's own photos, a like on the album for someone else's.
    public var favorite: Bool?
    /// Who Immich recognised in it (only those its key may see).
    public var people: [PhotoPerson]?

    public init(id: String, albumID: String, taken: Date? = nil, caption: String? = nil, place: String? = nil, width: Int? = nil, height: Int? = nil,
                filename: String? = nil, owner: String? = nil, favorite: Bool? = nil, people: [PhotoPerson]? = nil) {
        self.id = id; self.albumID = albumID; self.taken = taken; self.caption = caption; self.place = place; self.width = width; self.height = height
        self.filename = filename; self.owner = owner; self.favorite = favorite; self.people = people
    }

    public var starred: Bool { favorite ?? false }

    /// From an asset in `GET /albums/{id}` (v1/v2) or `POST /search/metadata` (v3). Nil for videos
    /// and trashed assets: a slideshow of slides has no use for them.
    init?(json o: [String: Any], albumID: String) {
        guard let id = o["id"] as? String else { return nil }
        if let type = o["type"] as? String, type != "IMAGE" { return nil }
        if o["isTrashed"] as? Bool == true { return nil }
        self.id = id
        self.albumID = albumID
        let exif = o["exifInfo"] as? [String: Any] ?? [:]
        taken = [o["localDateTime"], exif["dateTimeOriginal"], o["fileCreatedAt"]]
            .lazy.compactMap { ($0 as? String).flatMap(ImmichDate.wallClock) }.first
        caption = (exif["description"] as? String).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 }
        let parts = [exif["city"], exif["country"]].compactMap { ($0 as? String).flatMap { $0.isEmpty ? nil : $0 } }
        place = parts.isEmpty ? nil : parts.joined(separator: ", ")
        // Immich's own width / height (v1.1xx+), else the EXIF dimensions; orientation can swap them
        var w = (o["width"] as? Int) ?? (exif["exifImageWidth"] as? Int)
        var h = (o["height"] as? Int) ?? (exif["exifImageHeight"] as? Int)
        if o["width"] == nil, let orientation = (exif["orientation"] as? String).flatMap(Int.init) ?? (exif["orientation"] as? Int), orientation >= 5 { swap(&w, &h) }
        width = w; height = h
        filename = (o["originalFileName"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        owner = o["ownerId"] as? String
        favorite = o["isFavorite"] as? Bool
        if o["people"] != nil { people = PhotoPerson.list(o["people"]) }
    }

    /// Width over height, when Immich said.
    public var aspect: Double? {
        guard let width, let height, width > 0, height > 0 else { return nil }
        return Double(width) / Double(height)
    }

    /// The date as precisely as it is known (see `ImmichDate.text`).
    public var dateText: String? { taken.map(ImmichDate.text) }
}

/// Immich's dates. `localDateTime` is a wall clock written as if it were UTC ("…Z"), so it is
/// read and shown in UTC, where it can't shift by a time zone.
public enum ImmichDate {
    private static let utc = TimeZone(identifier: "UTC")!

    static func instant(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    /// The wall clock in a timestamp, whatever offset it carries ("1978-08-14T12:03:00.000Z",
    /// "1978-08-14T12:03:00+02:00" and "1978-08-14T12:03:00" all give 12:03 on 14 August 1978).
    static func wallClock(_ s: String) -> Date? {
        let digits = s.prefix(19)
        guard digits.count == 19 else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = utc
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        return f.date(from: String(digits))
    }

    /// Slide Station dates a slide at noon plus a minute per slide in the tray (`Uploader.photoDate`),
    /// on the 1st of the month when it only knew the month and on 1 January when it only knew the
    /// year. So a photo at that time of day on a 1st reads as "August 1978" or "1978"; anything else
    /// is a real date.
    public static func text(_ d: Date) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = utc
        let c = cal.dateComponents([.year, .month, .day, .hour], from: d)
        let slideStation = c.hour == 12 || c.hour == 13   // a tray holds at most ~100 slides
        let f = DateFormatter()
        f.timeZone = utc
        f.locale = .current
        if slideStation && c.day == 1 && c.month == 1 {
            f.setLocalizedDateFormatFromTemplate("y")
        } else if slideStation && c.day == 1 {
            f.setLocalizedDateFormatFromTemplate("MMMM y")
        } else {
            f.setLocalizedDateFormatFromTemplate("d MMMM y")
        }
        return f.string(from: d)
    }

    /// "1974 – 1981" for the photos' years (one year alone, or nil without dates).
    public static func span(_ photos: [AlbumPhoto]) -> String? {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = utc
        let years = photos.compactMap { $0.taken.map { cal.component(.year, from: $0) } }
        guard let lo = years.min(), let hi = years.max() else { return nil }
        return lo == hi ? "\(lo)" : "\(lo) – \(hi)"
    }
}

/// One person across an album: their name, how many slides, and the clearest face to show.
public struct AlbumPerson: Identifiable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var count: Int
    /// The photo with this person's biggest face, and that face.
    public var photoID: String
    public var box: [Double]

    /// The named people in these photos, most slides first.
    public static func of(_ photos: [AlbumPhoto]) -> [AlbumPerson] {
        var out: [String: AlbumPerson] = [:]
        var area: [String: Double] = [:]
        for p in photos {
            // a person counts once per photo, by their biggest face in it
            for (id, faces) in Dictionary(grouping: p.people ?? [], by: \.id) {
                guard let f = faces.max(by: { size($0) < size($1) }), !f.name.isEmpty else { continue }
                out[id, default: AlbumPerson(id: id, name: f.name, count: 0, photoID: p.id, box: f.box)].count += 1
                if size(f) > area[id, default: 0] { area[id] = size(f); out[id]?.photoID = p.id; out[id]?.box = f.box }
            }
        }
        return out.values.sorted { $0.count != $1.count ? $0.count > $1.count : $0.name < $1.name }
    }

    private static func size(_ f: PhotoPerson) -> Double { f.box.count == 4 ? (f.box[2] - f.box[0]) * (f.box[3] - f.box[1]) : 0 }
}
