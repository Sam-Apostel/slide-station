import ProUI
import SlideKit
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @AppStorage("studio") private var studio = false
    @State private var url = ""
    @State private var key = ""
    @State private var test: String?
    @State private var testing = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Server", text: $url, prompt: Text("http://immich.local:2283"))
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("API key", text: $key)
                    Button {
                        save(); testing = true
                        Task { test = await model.testImmich(); testing = false }
                    } label: { HStack { Text("Test connection"); if testing { Spacer(); ProgressView() } } }
                    .disabled(url.isEmpty || key.isEmpty)
                    if let test { Text(test).font(.footnote).foregroundStyle(test.hasPrefix("Connected") ? ProTheme.green : ProTheme.destructive) }
                } header: { Text("Immich") } footer: {
                    Text("The key needs asset.upload, asset.delete, album.read, album.create and albumAsset.create. It's kept in this device's keychain.")
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
                    Toggle("Studio mode on iPad", isOn: $studio)
                } footer: {
                    Text("Studio has the detailed tools — sliders, histogram, bracket scans, dates — for a trackpad or pencil. Simple mode is keep, skip, turn.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { save(); dismiss() } } }
            .onAppear { url = model.immich.url; key = model.immich.key }
        }
    }

    private func save() { model.immich = ImmichSettings(url: url, key: key) }
}
