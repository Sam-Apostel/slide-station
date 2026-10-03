import ProUI
import SlideAlbums
import SlideKit
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(AlbumLibrary.self) private var albums
    @Environment(\.dismiss) private var dismiss
    @AppStorage("studio") private var studio = Platform.studioDefault
    @State private var url = ""
    @State private var key = ""
    @State private var pickingLibrary = false
    @State private var choosing = false
    @State private var interval = SlideshowSettings.interval
    @State private var shuffle = SlideshowSettings.shuffle

    var body: some View {
        NavigationStack {
            Form {
                ImmichForm(url: $url, key: $key)
                if albums.isConnected {
                    Section {
                        Button { choosing = true } label: {
                            LabeledContent("Albums to show", value: albums.followedAlbums.isEmpty ? "None" : albums.followedAlbums.map(\.name).joined(separator: ", "))
                        }
                        Picker("Each photo", selection: $interval) {
                            ForEach(SlideshowSettings.intervals, id: \.self) { s in Text(s < 60 ? "\(Int(s)) seconds" : "1 minute").tag(s) }
                        }
                        Toggle("Shuffle", isOn: $shuffle)
                        Button("Disconnect from Immich", role: .destructive) { albums.disconnect(); url = ""; key = "" }
                    } header: { Text("Slideshow") } footer: {
                        Text("The albums you follow play in the slideshow, rotate through the Home Screen widget and show on Apple TV.")
                    }
                }
                Section("Scanner") {
                    if let card = model.card {
                        LabeledContent("Connected", value: card.name)
                        LabeledContent("Scans on card", value: "\(card.count)")
                    } else {
                        LabeledContent("Status", value: model.cardPicked ? "Not plugged in" : "Not set up")
                    }
                    if model.cardPicked { Button("Forget the scanner", role: .destructive) { model.forgetCard() } }
                }
                Section {
                    LabeledContent("Trays", value: model.libraryFolder?.lastPathComponent ?? (Platform.isMac ? "On this Mac" : "On this device"))
                    Button(model.libraryFolder == nil ? (Platform.isMac ? "Use another folder…" : "Use a folder in Files…") : "Choose another folder…") { pickingLibrary = true }
                    if model.libraryFolder != nil {
                        Button(Platform.isMac ? "Use this Mac's own library" : "Use this device's own library") { Task { await model.useLibrary(nil) } }
                    }
                } header: { Text("Library") } footer: {
                    Text("To share trays with the Mac app, put its library folder in iCloud Drive (Settings → Library in the Mac app) and pick that folder here — the one with “sessions” in it. Both apps then see the same trays, edits and learning. Switching doesn't move any trays.")
                }
                Section {
                    Toggle("Learn from developed slides", isOn: Bindable(model).learningEnabled)
                    Toggle("Keep original scans after upload", isOn: Bindable(model).keepOriginals)
                } footer: {
                    Text("Learning suggests colour settings for new slides from the ones you developed (\(model.learning.examples.count) so far). With originals off, a tray's scans are deleted from this device once all its slides are in Immich; those slides can't be edited any more unless you import the scans again.")
                }
                Section {
                    Toggle("Studio mode", isOn: $studio)
                } footer: {
                    Text("Studio has the detailed tools — curves, sliders, crop, bracket scans, dates. On a phone they're under the photo, one at a time. Simple mode is keep, skip, turn.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { save(); dismiss() } } }
            .onAppear { url = albums.connection.url; key = albums.connection.key }
            .onChange(of: interval) { SlideshowSettings.interval = interval }
            .onChange(of: shuffle) { SlideshowSettings.shuffle = shuffle }
            .sheet(isPresented: $choosing) { ChooseAlbumsView() }
            .formStyle(.grouped)
            .fileImporter(isPresented: $pickingLibrary, allowedContentTypes: [.folder]) { result in
                if case .success(let folder) = result { Task { await model.useLibrary(folder) } }
            }
        }
    }

    /// Done keeps what was typed even untested (uploads find out soon enough).
    private func save() { model.immich = ImmichSettings(url: url, key: key) }
}
