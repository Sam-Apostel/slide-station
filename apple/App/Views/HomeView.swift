import ProUI
import SlideKit
import SwiftUI

/// One big "Import from scanner", and the trays done so far.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @State private var picking = false
    @State private var naming = false
    @State private var settings = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                HStack {
                    Text("Slide Station").font(.system(size: 30, weight: .bold))
                    Spacer()
                    Button { settings = true } label: { Image(systemName: "gearshape").font(.system(size: 20)) }
                        .foregroundStyle(ProTheme.muted).accessibilityLabel("Settings")
                }
                scanner
                if !model.trays.isEmpty { trays }
            }
            .padding(20)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
        .refreshable { await model.refresh(); await model.checkCard() }
        .fileImporter(isPresented: $picking, allowedContentTypes: [.folder]) { result in
            if case .success(let url) = result { Task { await model.pickCard(url) } }
        }
        .sheet(isPresented: $naming) { NewTraySheet() }
        .sheet(isPresented: $settings) { SettingsView() }
    }

    @ViewBuilder private var scanner: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let card = model.card {
                Label(card.scanner ? "Slide N Scan connected" : "\(card.name) connected", systemImage: "externaldrive.fill.badge.checkmark")
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(ProTheme.green)
                Text(card.new > 0 ? "\(card.new) new scans on the card (\(card.count) in total)." : "No new scans on the card — everything on it is already imported.")
                    .foregroundStyle(ProTheme.muted)
                Button { naming = true } label: { Label("Import from scanner", systemImage: "square.and.arrow.down") }
                    .buttonStyle(BigButtonStyle(prominent: true)).disabled(card.new == 0 || model.busy)
            } else if model.cardPicked {
                Label("Scanner not plugged in", systemImage: "externaldrive.badge.xmark")
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(ProTheme.muted)
                Text("Plug the scanner in (switch it on) and come back here.").foregroundStyle(ProTheme.muted)
                HStack(spacing: 12) {
                    Button("Check again") { Task { await model.checkCard() } }.buttonStyle(BigButtonStyle(prominent: true))
                    Button("Choose folder") { picking = true }.buttonStyle(BigButtonStyle())
                }
            } else {
                Label("Connect the scanner", systemImage: "externaldrive.badge.plus")
                    .font(.system(size: 15, weight: .semibold))
                Text("Plug the scanner in and switch it on. Then pick its card in the list that opens — it shows up under Locations. You only do this once.")
                    .foregroundStyle(ProTheme.muted).fixedSize(horizontal: false, vertical: true)
                Button { picking = true } label: { Label("Find the scanner", systemImage: "folder") }
                    .buttonStyle(BigButtonStyle(prominent: true))
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ProTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(ProTheme.line, lineWidth: 1) }
    }

    private var trays: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("TRAYS").font(.system(size: 11, weight: .semibold)).tracking(0.8).foregroundStyle(ProTheme.dim)
            ForEach(model.trays) { tray in
                Button { Task { await model.open(tray.id) } } label: { TrayRow(tray: tray) }
                    .buttonStyle(.plain)
                    .contextMenu {
                        Button("Delete tray", systemImage: "trash", role: .destructive) { Task { await model.delete(tray.id) } }
                    }
            }
        }
    }
}

struct TrayRow: View {
    @Environment(AppModel.self) private var model
    let tray: Tray
    var body: some View {
        let s = tray.summary()
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(tray.name).font(.system(size: 17, weight: .semibold))
                if !tray.date.isEmpty { Text(tray.date).foregroundStyle(ProTheme.muted) }
                // where it lives, when the name says something else
                if !tray.placeLabel.isEmpty, tray.name != tray.placeLabel { Text(tray.placeLabel).foregroundStyle(ProTheme.muted) }
                Spacer()
                Text(s.uploaded == s.slides - s.skipped && s.slides > 0 ? "In Immich" : "\(s.developed) of \(s.slides) done")
                    .font(.system(size: 13, weight: .medium).monospacedDigit())
                    .foregroundStyle(s.uploaded == s.slides - s.skipped && s.slides > 0 ? ProTheme.green : ProTheme.muted)
                Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(ProTheme.dim)
            }
            TraySlots(statuses: tray.statuses(), size: model.box(of: tray)?.size)
        }
        .padding(16)
        .background(ProTheme.canvas, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(ProTheme.lineSoft, lineWidth: 1) }
        .contentShape(Rectangle())
    }
}

/// Where the tray lives (box and side) and its name (the Immich album) before importing.
struct NewTraySheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var boxText = ""
    @State private var side: Tray.Side = .left
    @State private var size = Box.sizes[0]
    @State private var writing = ""
    @State private var name = ""
    @State private var year = ""

    /// Empty: not in a box.
    private var boxNumber: Int? { Int(boxText.trimmingCharacters(in: .whitespaces)).flatMap { $0 > 0 ? $0 : nil } }
    private var badBox: Bool { !boxText.trimmingCharacters(in: .whitespaces).isEmpty && boxNumber == nil }
    private var known: Box? { boxNumber.flatMap { model.boxes[$0] } }
    private func taken(_ s: Tray.Side) -> Bool { boxNumber.map { model.tray(inBox: $0, side: s) != nil } ?? false }
    private var trimmedName: String { name.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Box", text: $boxText, prompt: Text("Box number, or none"))
                        .keyboardType(.numberPad)
                    Picker("Tray", selection: $side) {
                        ForEach(Tray.Side.allCases, id: \.self) { s in
                            Text(s == .left ? "Left" : "Right").tag(s)
                        }
                    }
                    .pickerStyle(.segmented)
                    .disabled(boxNumber == nil)
                    if boxNumber != nil, known == nil {
                        Picker("Trays of", selection: $size) {
                            ForEach(Box.sizes, id: \.self) { Text("\($0) slides").tag($0) }
                        }
                        TextField("Written on the box", text: $writing, prompt: Text("optional, as it says"))
                    }
                } footer: {
                    if badBox {
                        Text("The box number is a whole number; leave it empty for a tray that isn't in a box.").foregroundStyle(.red)
                    } else if taken(side), let n = boxNumber {
                        Text("Box \(n) \(side.rawValue) is already the tray “\(model.tray(inBox: n, side: side)?.name ?? "")”.").foregroundStyle(.red)
                    } else if let k = known {
                        Text("Trays of \(k.size)" + (k.writing.isEmpty ? "" : " · “\(k.writing)”"))
                    } else {
                        Text("Each box holds two trays side by side, left and right.")
                    }
                }
                Section {
                    TextField("Name", text: $name, prompt: Text(Tray.label(box: boxNumber, side: side).isEmpty ? "e.g. Lake Garda summer" : Tray.label(box: boxNumber, side: side)))
                    TextField("When (optional)", text: $year, prompt: Text("1978 or 1978-08"))
                        .keyboardType(.numbersAndPunctuation)
                } footer: {
                    Text("The name becomes the album in Immich; in a box it's named after where it lives unless you give it a name. A year or month dates every slide in the tray; you can date single slides later.")
                }
            }
            .navigationTitle("New tray")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Import") {
                        let newBox = boxNumber != nil && known == nil
                        model.importFromCard(name: trimmedName, date: year.trimmingCharacters(in: .whitespaces),
                                             box: boxNumber, side: boxNumber == nil ? nil : side,
                                             boxSize: newBox ? size : nil,
                                             boxWriting: newBox ? writing.trimmingCharacters(in: .whitespaces) : nil)
                        dismiss()
                    }
                    .disabled(badBox || taken(side) || (boxNumber == nil && trimmedName.isEmpty)
                              || (!year.isEmpty && SlideDates.parse(year) == nil))
                }
            }
            .onChange(of: boxText) {
                // the side that's free, when the box you typed has one tray already
                if taken(side), let free = Tray.Side.allCases.first(where: { !taken($0) }) { side = free }
            }
        }
        .onAppear {
            guard boxText.isEmpty else { return }
            let next = model.nextPlace()
            boxText = String(next.box); side = next.side
        }
        .presentationDetents([.large])
    }
}
