import AppIntents
import SlideAlbums
import SwiftUI
import WidgetKit

/// A slide from the followed albums on the Home Screen, a different one every so often, round
/// all of them in turn (`Rotation`). Tapping it opens that slide in the app.
@main
struct SlideWidgets: WidgetBundle {
    var body: some Widget { SlideWidget() }
}

struct SlideWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "slides", provider: Provider()) { entry in
            SlideEntryView(entry: entry)
        }
        .configurationDisplayName("Slides")
        .description("A slide from your albums, a different one every hour or so.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .systemExtraLarge])
        .contentMarginsDisabled()
    }
}

struct SlideEntry: TimelineEntry {
    let date: Date
    /// A small JPEG in the App Group (the widget's ~30 MB can't hold several decoded images).
    var file: URL?
    var photo: AlbumPhoto?
    var album: String?
    /// Why there's no photo.
    var note: String?
}

struct Provider: TimelineProvider {
    /// How long each slide stays. Widgets get a limited number of reloads a day; this spends few.
    static let every: TimeInterval = 45 * 60
    static let perTimeline = 6

    func placeholder(in context: Context) -> SlideEntry { SlideEntry(date: Date()) }

    func getSnapshot(in context: Context, completion: @escaping (SlideEntry) -> Void) {
        Task {
            let entries = await entries(count: 1, size: context.displaySize, scale: context.isPreview ? 2 : 3, advance: false)
            completion(entries.first ?? SlideEntry(date: Date(), note: "Your slides appear here"))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SlideEntry>) -> Void) {
        Task {
            let entries = await entries(count: Self.perTimeline, size: context.displaySize, scale: 3, advance: true)
            let end = entries.last.map { $0.date.addingTimeInterval(Self.every) } ?? Date().addingTimeInterval(30 * 60)
            completion(Timeline(entries: entries, policy: .after(entries.first?.photo == nil ? Date().addingTimeInterval(30 * 60) : end)))
        }
    }

    /// The slides this timeline shows and when it started. Kept in the App Group, so a reload in the
    /// middle of it (tapping the star reloads the widget) shows the same slide, not the next one.
    private struct Plan: Codable { var start: Date; var ids: [String] }

    private static var plan: Plan? {
        get { SharedStore.defaults.data(forKey: "widgetPlan").flatMap { try? JSONDecoder().decode(Plan.self, from: $0) } }
        set { SharedStore.defaults.set(newValue.flatMap { try? JSONEncoder().encode($0) }, forKey: "widgetPlan") }
    }

    /// The next `count` slides, each written out at the widget's size, one every `every`.
    private func entries(count: Int, size: CGSize, scale: CGFloat, advance: Bool) async -> [SlideEntry] {
        let connection = ImmichKeychain.load()
        let client = connection.flatMap { try? AlbumClient($0) }
        guard client != nil || !SharedStore.followed.isEmpty else {
            return [SlideEntry(date: Date(), note: "Open Slide Station and connect to Immich")]
        }
        guard !SharedStore.followed.isEmpty else {
            return [SlideEntry(date: Date(), note: "Choose albums in Slide Station")]
        }
        let photos = await AlbumCache.followedPhotos(maxAge: 6 * 3600, client: client)
        guard !photos.isEmpty else { return [SlideEntry(date: Date(), note: "No slides in your albums yet")] }
        let byID = Dictionary(photos.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var picks: [AlbumPhoto]
        var start = Date()
        if let plan = Self.plan, Date() < plan.start.addingTimeInterval(Double(plan.ids.count) * Self.every),
           plan.ids.allSatisfy({ byID[$0] != nil }) {
            // still in the middle of the last plan: the same slides, starred as they are now
            picks = plan.ids.compactMap { byID[$0] }
            start = plan.start
            if !advance {
                let i = min(picks.count - 1, max(0, Int(Date().timeIntervalSince(start) / Self.every)))
                picks = [picks[i]]; start = Date()
            }
        } else if advance {
            var rotation = Rotation()
            picks = rotation.next(count, of: photos)
            Self.plan = Plan(start: start, ids: picks.map(\.id))
        } else {
            var peek = Rotation(defaults: UserDefaults())   // a snapshot doesn't move the real place
            picks = peek.next(1, of: photos)
        }
        let px = Int(max(size.width, size.height) * scale)
        let albums = Dictionary((AlbumCache.albums() ?? []).map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
        var out: [SlideEntry] = []
        for (i, p) in picks.enumerated() {
            let file = await Self.image(p, maxPixel: max(300, px), client: client)
            out.append(SlideEntry(date: start.addingTimeInterval(Double(i) * Self.every), file: file, photo: p, album: albums[p.albumID]))
        }
        Self.tidy(keep: Set(out.compactMap(\.file)))
        return out.isEmpty ? [SlideEntry(date: Date(), note: "Couldn't reach Immich")] : out
    }

    private static var folder: URL { SharedStore.folder.appendingPathComponent("Widget", isDirectory: true) }

    /// The photo as a JPEG no bigger than the widget, in the App Group.
    private static func image(_ p: AlbumPhoto, maxPixel: Int, client: AlbumClient?) async -> URL? {
        let url = folder.appendingPathComponent("\(p.id)-\(maxPixel).jpg")
        if FileManager.default.fileExists(atPath: url.path) { return url }
        guard let client, let data = try? await PhotoImages.shared.data(p.id, size: .preview, client: client),
              let img = PhotoImages.decode(data, maxPixel: maxPixel), let jpeg = PhotoImages.jpeg(img) else { return nil }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try? jpeg.write(to: url, options: .atomic)
        return url
    }

    /// Only the images the current timeline shows stay.
    private static func tidy(keep: Set<URL>) {
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
        for f in files where !keep.contains(f) { try? FileManager.default.removeItem(at: f) }
    }
}

struct SlideEntryView: View {
    let entry: SlideEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            if let file = entry.file, let img = UIImage(contentsOfFile: file.path) {
                Image(uiImage: img).resizable().aspectRatio(contentMode: .fill)
                if family != .systemSmall, let p = entry.photo { caption(p) }
                if let p = entry.photo { star(p) }
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Image(systemName: "photo.stack").font(.system(size: 24)).foregroundStyle(Color(red: 0.95, green: 0.70, blue: 0.29))
                    Text(entry.note ?? "Slide Station").font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                }
                .padding(16)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
            }
        }
        .containerBackground(for: .widget) { Color(red: 0.055, green: 0.055, blue: 0.063) }
        .widgetURL(entry.photo.map { URL(string: "slidestation://photo/\($0.albumID)/\($0.id)")! })
    }

    /// Tap to star (favorite in Immich, or like it on someone else's album); runs in the widget.
    private func star(_ p: AlbumPhoto) -> some View {
        Button(intent: StarSlide(photoID: p.id, albumID: p.albumID, on: !p.starred)) {
            Image(systemName: p.starred ? "star.fill" : "star")
                .font(.system(size: family == .systemSmall ? 13 : 15, weight: .semibold))
                .foregroundStyle(p.starred ? Color(red: 0.95, green: 0.70, blue: 0.29) : .white)
                .frame(width: family == .systemSmall ? 28 : 32, height: family == .systemSmall ? 28 : 32)
                .background(.black.opacity(0.45), in: Circle())
                .overlay { Circle().strokeBorder(.white.opacity(0.18), lineWidth: 0.5) }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(p.starred ? "Unstar" : "Star")
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
        .padding(family == .systemSmall ? 8 : 10)
    }

    private func caption(_ p: AlbumPhoto) -> some View {
        let meta = [p.dateText, p.place].compactMap { $0 }.joined(separator: " · ")
        return VStack(alignment: .leading, spacing: 2) {
            if let c = p.caption { Text(c).font(.system(size: 14, weight: .semibold)).lineLimit(family == .systemMedium ? 1 : 2) }
            if !meta.isEmpty { Text(meta).font(.system(size: 11, weight: .medium)).opacity(0.8).lineLimit(1) }
        }
        .foregroundStyle(.white)
        .shadow(color: .black.opacity(0.7), radius: 4)
        .padding(.horizontal, 14).padding(.bottom, 12).padding(.top, 30)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background { LinearGradient(colors: [.clear, .black.opacity(0.55)], startPoint: .top, endPoint: .bottom) }
        .opacity(p.caption == nil && meta.isEmpty ? 0 : 1)
    }
}

/// The widget's star: favorite the slide in Immich (one's own photo) or like it on the album
/// (someone else's). The widget shows the change at once; WidgetKit reloads it afterwards.
struct StarSlide: AppIntent {
    static let title: LocalizedStringResource = "Star a slide"
    static let isDiscoverable = false

    @Parameter(title: "Photo") var photoID: String
    @Parameter(title: "Album") var albumID: String
    @Parameter(title: "Starred") var on: Bool

    init() {}
    init(photoID: String, albumID: String, on: Bool) {
        self.photoID = photoID; self.albumID = albumID; self.on = on
    }

    func perform() async throws -> some IntentResult {
        let photo = AlbumCache.photos(albumID)?.photos.first { $0.id == photoID } ?? AlbumPhoto(id: photoID, albumID: albumID)
        AlbumCache.setStarred(photoID, albumID: albumID, on)
        guard let c = ImmichKeychain.load(), let client = try? AlbumClient(c) else { return .result() }
        do { try await client.star(photo, on, me: SharedStore.userID) } catch {
            AlbumCache.setStarred(photoID, albumID: albumID, !on)   // Immich said no: as it was
            throw error
        }
        return .result()
    }
}
