import MapKit
import ProUI
import SlideInsights
import SlideKit
import SwiftUI

/// A slide's tags, place and suggested caption (the web app's `slide-insights.tsx`): its own tags
/// as chips, the suggested ones beside them to take or dismiss; where it was taken, with a place
/// read from a sign or from the slides around it; a caption written by Apple Intelligence.
struct SlideSuggestions: View {
    @Environment(AppModel.self) private var model
    let slide: Slide
    @State private var newTag = ""
    @State private var picking = false
    @State private var applying: Applying?

    struct Applying: Identifiable { let kind: Insights.Kind; let value: String; let place: Slide.Place?; var id: String { kind.rawValue + value } }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if model.insights.working == slide.id {
                Label("Looking at this slide…", systemImage: "sparkle.magnifyingglass").font(.system(size: 11)).foregroundStyle(ProTheme.dim)
            }
            if let e = slide.insights?["error"]?.text, !e.isEmpty {
                Label("Couldn't look at this slide: \(e)", systemImage: "exclamationmark.triangle").font(.system(size: 11)).foregroundStyle(ProTheme.dim)
            }
            caption
            label("Tags")
            tags
            label("Place")
            place
        }
        .sheet(isPresented: $picking) { PlacePicker(current: slide.place) { model.setPlace($0) } }
        .popover(item: $applying) { a in ApplyRange(kind: a.kind, value: a.value, place: a.place) { applying = nil } }
    }

    private func label(_ s: String) -> some View { Text(s).font(.system(size: 11)).foregroundStyle(ProTheme.muted).padding(.top, 4) }

    // MARK: caption

    @ViewBuilder private var caption: some View {
        if (slide.caption ?? "").isEmpty, let s = slide.suggestion(.caption), s.state == .suggested {
            VStack(alignment: .leading, spacing: 6) {
                Label("Suggested caption", systemImage: "sparkles").font(.system(size: 11, weight: .semibold)).foregroundStyle(ProTheme.accent)
                Text(s.value).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 14) {
                    Button("Use it") { model.decide(.caption, accept: true) }.fontWeight(.semibold)
                    Button("Dismiss") { model.decide(.caption, accept: false) }.foregroundStyle(ProTheme.muted)
                }
                .buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(ProTheme.accent)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ProTheme.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 7))
        }
    }

    // MARK: tags

    private var tags: some View {
        let own = slide.tags ?? []
        let open = slide.tagSuggestions.filter { $0.state == .suggested && !own.contains($0.value) }
        return VStack(alignment: .leading, spacing: 6) {
            Flow(spacing: 6) {
                ForEach(own, id: \.self) { t in
                    Chip(text: t, style: .own) { model.setTags(own.filter { $0 != t }) }
                        .contextMenu { applyButton(.tags, t) }
                }
                ForEach(open) { s in
                    Chip(text: s.value, style: .suggested) { model.decide(.tags, accept: false, value: s.value) }
                        .onTapGesture { model.decide(.tags, accept: true, value: s.value) }
                        .accessibilityHint("Suggested. Tap to add it")
                }
                TextField("Add a tag", text: $newTag)
                    .textFieldStyle(.plain).font(.system(size: 12))
                    .frame(minWidth: 80, maxWidth: 140)
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(SS.field, in: Capsule())
                    .overlay { Capsule().strokeBorder(ProTheme.line, lineWidth: 1) }
                    .autocorrectionDisabled()
                    .onSubmit { let t = newTag; newTag = ""; if !t.trimmingCharacters(in: .whitespaces).isEmpty { model.setTags(own + [t]) } }
            }
            if open.count > 1 {
                HStack(spacing: 14) {
                    Button("Add all") { model.decide(.tags, accept: true) }
                    Button("Dismiss all") { model.decide(.tags, accept: false) }.foregroundStyle(ProTheme.muted)
                }
                .buttonStyle(.plain).font(.system(size: 11, weight: .medium)).foregroundStyle(ProTheme.accent)
            }
        }
    }

    private func applyButton(_ kind: Insights.Kind, _ value: String, place: Slide.Place? = nil) -> some View {
        Button("Apply to a range of slides…", systemImage: "rectangle.stack.badge.plus") { applying = Applying(kind: kind, value: value, place: place) }
    }

    // MARK: place

    private var place: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Button { picking = true } label: {
                    HStack(spacing: 6) {
                        Image(systemName: slide.place == nil ? "mappin.slash" : "mappin.and.ellipse").foregroundStyle(slide.place == nil ? ProTheme.dim : ProTheme.accent)
                        Text(slide.place?.label ?? "Where was it taken?").foregroundStyle(slide.place == nil ? ProTheme.dim : ProTheme.ink).lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .font(.system(size: 12))
                    .frame(minHeight: 18)
                    .padding(.horizontal, 8).padding(.vertical, 6)
                    .background(SS.field, in: RoundedRectangle(cornerRadius: 5))
                    .overlay { RoundedRectangle(cornerRadius: 5).strokeBorder(ProTheme.line, lineWidth: 1) }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .contextMenu { if let p = slide.place { applyButton(.place, p.label, place: p) } }
                if slide.place != nil {
                    Button { model.setPlace(nil) } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(ProTheme.dim) }
                        .buttonStyle(.plain).accessibilityLabel("Clear the place")
                }
            }
            if slide.place == nil, let s = slide.suggestion(.place), s.state == .suggested, let p = s.place {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Image(systemName: s.source == Insights.traySource ? "rectangle.stack" : "text.viewfinder").foregroundStyle(ProTheme.accent)
                        Text(p.label).font(.system(size: 12, weight: .medium))
                    }
                    Text(s.source == Insights.traySource ? "Like \(s.text ?? "the slides around it")" : "Read on the slide: “\(s.text ?? "")”")
                        .font(.system(size: 10)).foregroundStyle(ProTheme.dim).lineLimit(2)
                    HStack(spacing: 14) {
                        Button("Use it") { model.decide(.place, accept: true) }.fontWeight(.semibold)
                        Button("Dismiss") { model.decide(.place, accept: false) }.foregroundStyle(ProTheme.muted)
                    }
                    .buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(ProTheme.accent)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(ProTheme.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 7))
            }
        }
    }
}

/// A tag: the slide's own (× takes it off) or suggested (dashed; tap to add, × to dismiss).
struct Chip: View {
    enum Style { case own, suggested }
    let text: String
    let style: Style
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            if style == .suggested { Image(systemName: "plus").font(.system(size: 9, weight: .bold)) }
            Text(text).lineLimit(1)
            Button(action: remove) { Image(systemName: "xmark").font(.system(size: 8, weight: .bold)).padding(3).contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .accessibilityLabel(style == .own ? "Remove \(text)" : "Dismiss \(text)")
        }
        .font(.system(size: 12))
        .foregroundStyle(style == .own ? ProTheme.ink : ProTheme.accent)
        .padding(.leading, 9).padding(.trailing, 4).padding(.vertical, 3)
        .background(style == .own ? SS.panel2 : ProTheme.accent.opacity(0.08), in: Capsule())
        .overlay {
            Capsule().strokeBorder(style == .own ? ProTheme.line : ProTheme.accent.opacity(0.6), style: StrokeStyle(lineWidth: 1, dash: style == .own ? [] : [3, 2]))
        }
        .contentShape(Capsule())
    }
}

/// "Apply 'beach' to slides 12–31" (server's insights/propagate): a tag added to each, or a place
/// given to each. Numbers as in the filmstrip.
struct ApplyRange: View {
    @Environment(AppModel.self) private var model
    let kind: Insights.Kind
    let value: String
    let place: Slide.Place?
    let done: () -> Void
    @State private var from = 1
    @State private var to = 1

    var body: some View {
        let n = max(1, model.tray?.groups.count ?? 1)
        VStack(alignment: .leading, spacing: 10) {
            Text(kind == .tags ? "Tag slides “\(value)”" : "Place slides in \(value)").font(.system(size: 13, weight: .semibold))
            Stepper("From slide \(from)", value: $from, in: 1...n)
            Stepper("To slide \(to)", value: $to, in: 1...n)
            Text(kind == .tags ? "Each slide in the range gets the tag too. Locked slides are left as they are." : "Each slide in the range gets this place. Locked slides are left as they are.")
                .font(.system(size: 10)).foregroundStyle(ProTheme.dim)
            HStack {
                Spacer()
                Button("Cancel", action: done)
                Button("Apply") { model.apply(kind, value: value, place: place, from: from - 1, to: to - 1); done() }.buttonStyle(.borderedProminent)
            }
        }
        .padding(16)
        .frame(minWidth: 280)
        .onAppear { from = model.selection + 1; to = model.rangeEnd(from: model.selection) + 1 }
    }
}

/// Wraps its children onto as many lines as they need.
struct Flow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(proposal.width ?? .infinity, subviews)
        return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: rows.last.map { $0.y + $0.height } ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for row in arrange(bounds.width, subviews) {
            var x = bounds.minX
            for i in row.items {
                let s = subviews[i].sizeThatFits(.unspecified)
                subviews[i].place(at: CGPoint(x: x, y: bounds.minY + row.y + (row.height - s.height) / 2), proposal: ProposedViewSize(s))
                x += s.width + spacing
            }
        }
    }

    private struct Row { var items: [Int] = []; var y: CGFloat = 0; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func arrange(_ width: CGFloat, _ subviews: Subviews) -> [Row] {
        var rows: [Row] = [], row = Row()
        for i in subviews.indices {
            let s = subviews[i].sizeThatFits(.unspecified)
            if !row.items.isEmpty && row.width + spacing + s.width > width {
                rows.append(row)
                row = Row(y: row.y + row.height + spacing)
            }
            row.width += (row.items.isEmpty ? 0 : spacing) + s.width
            row.height = max(row.height, s.height)
            row.items.append(i)
        }
        if !row.items.isEmpty { rows.append(row) }
        return rows
    }
}

/// Where a slide was taken: Apple Maps' places as you type (towns, regions, landmarks), or
/// coordinates ("45.4371, 12.3326").
struct PlacePicker: View {
    let current: Slide.Place?
    let pick: (Slide.Place?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var search = PlaceSearch()
    @State private var query = ""
    @State private var failed: String?

    var body: some View {
        NavigationStack {
            List {
                if let c = coords {
                    Button { choose(Slide.Place(name: "", lat: c.0, lon: c.1)) } label: {
                        Label("At \(Slide.Place.coordsLabel(c.0, c.1))", systemImage: "location")
                    }
                }
                ForEach(search.results, id: \.self) { r in
                    Button { Task { await choose(r) } } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(r.title).foregroundStyle(ProTheme.ink)
                            if !r.subtitle.isEmpty { Text(r.subtitle).font(.footnote).foregroundStyle(.secondary) }
                        }
                    }
                }
                if let failed { Text(failed).foregroundStyle(.secondary) }
                if query.isEmpty, let current {
                    Section { Button("Clear “\(current.label)”", role: .destructive) { pick(nil); dismiss() } }
                }
            }
            #if os(macOS)
            .searchable(text: $query, prompt: "A town, a region, a landmark")
            #else
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "A town, a region, a landmark")
            #endif
            .onChange(of: query) { _, q in failed = nil; search.query = q }
            .navigationTitle("Where was it taken?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 480)
        #endif
    }

    /// "45.4371, 12.3326" as (lat, lon) (places.parse_coords).
    private var coords: (Double, Double)? {
        let parts = query.split(whereSeparator: { ",; ".contains($0) }).compactMap { Double($0) }
        guard parts.count == 2, (-90...90).contains(parts[0]), (-180...180).contains(parts[1]) else { return nil }
        return (parts[0], parts[1])
    }

    private func choose(_ p: Slide.Place) { pick(p); dismiss() }

    private func choose(_ r: MKLocalSearchCompletion) async {
        do {
            guard let item = try await MKLocalSearch(request: MKLocalSearch.Request(completion: r)).start().mapItems.first else { return }
            choose(PlaceSearch.place(item, title: r.title))
        } catch {
            failed = "Apple Maps didn't answer: \(error.localizedDescription)"
        }
    }
}

/// Apple Maps' suggestions as you type.
@Observable
final class PlaceSearch: NSObject, MKLocalSearchCompleterDelegate {
    private(set) var results: [MKLocalSearchCompletion] = []
    @ObservationIgnored private let completer = MKLocalSearchCompleter()

    var query = "" { didSet { if query.isEmpty { results = [] } else { completer.queryFragment = query } } }

    override init() {
        super.init()
        completer.delegate = self
        completer.resultTypes = [.address, .pointOfInterest]
    }

    func completerDidUpdateResults(_ completer: MKLocalSearchCompleter) { results = Array(completer.results.prefix(12)) }
    func completer(_ completer: MKLocalSearchCompleter, didFailWithError error: Error) { results = [] }

    /// A map item as a slide's place: the town (or the landmark), its country and region.
    static func place(_ item: MKMapItem, title: String) -> Slide.Place {
        func same(_ s: String) -> String? { SignPlaces.fold(s) == SignPlaces.fold(title) ? s : nil }
        if #available(iOS 26, macOS 26, *) {
            let c = item.location.coordinate, a = item.addressRepresentations
            return Slide.Place(name: a?.cityName.flatMap(same) ?? item.name ?? title, lat: c.latitude, lon: c.longitude, country: a?.regionName ?? "")
        }
        let pm = item.placemark
        return Slide.Place(name: pm.locality.flatMap(same) ?? item.name ?? title, lat: pm.coordinate.latitude, lon: pm.coordinate.longitude,
                           country: pm.country ?? "", admin: pm.administrativeArea)
    }
}
