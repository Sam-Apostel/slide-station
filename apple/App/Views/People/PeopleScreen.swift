import ProUI
import SlideFaces
import SlideKit
import SwiftUI

/// Everyone on your slides (`components/people.tsx`): the people you named, then the groups it
/// found that nobody named yet ("Who are they?"). A person: their name and birthday, their faces
/// ("Not them" takes one out), the same person as someone else, or ignored.
struct PeopleScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var showIgnored = false

    var body: some View {
        NavigationStack {
            List {
                if let d = model.people.file {
                    let named = d.ids.filter { d.known($0) && !d.ignored($0) }.sorted { d.label($0).lowercased() < d.label($1).lowercased() }
                    let unnamed = d.ids.filter { !d.known($0) && !d.ignored($0) && d.faces($0).count >= 2 }.sorted { d.faces($0).count > d.faces($1).count }
                    let ignored = d.ids.filter { d.ignored($0) }
                    if named.isEmpty && unnamed.isEmpty {
                        Text(model.people.enabled ? "No people yet: faces are found as you look through your trays, or all at once from Settings." : "Turn on “Recognise people” in Settings.")
                            .foregroundStyle(.secondary)
                    }
                    if !named.isEmpty { Section("People") { ForEach(named, id: \.self) { row($0, d) } } }
                    if !unnamed.isEmpty {
                        Section { ForEach(unnamed, id: \.self) { row($0, d) } } header: { Text("Who are they?") } footer: {
                            Text("Faces found more than once that nobody named yet. Name one and the name goes to every slide they're on.")
                        }
                    }
                    if !ignored.isEmpty {
                        Section {
                            if showIgnored { ForEach(ignored, id: \.self) { row($0, d) } }
                            Button(showIgnored ? "Hide ignored people" : "Show \(ignored.count) ignored") { showIgnored.toggle() }
                        }
                    }
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("People")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { PersonScreen(pid: $0) }
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await model.people.reload() }
        }
        #if os(macOS)
        .frame(minWidth: 520, minHeight: 560)
        #endif
    }

    private func row(_ pid: String, _ d: People.File) -> some View {
        NavigationLink(value: pid) {
            HStack(spacing: 12) {
                if let f = model.people.stored(d.faces(pid)).first { FaceImage(face: f, size: 44) } else { Circle().fill(SS.panel2).frame(width: 44, height: 44) }
                VStack(alignment: .leading, spacing: 2) {
                    Text(d.label(pid)).foregroundStyle(d.known(pid) ? ProTheme.ink : ProTheme.muted)
                    Text([d.faces(pid).count == 1 ? "1 slide" : "\(d.faces(pid).count) slides", d.people[pid]?["birthday"].flatMap { if case .string(let b) = $0, !b.isEmpty { return "born \(b)" }; return nil }]
                            .compactMap { $0 }.joined(separator: " · "))
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
    }
}

struct PersonScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let pid: String
    @State private var name = ""
    @State private var birthday = ""

    var body: some View {
        let fail: (String) -> Void = { model.error = $0 }
        Group {
            if let d = model.people.file, d.people[pid] != nil {
                let faces = model.people.stored(d.faces(pid))
                Form {
                    Section {
                        TextField("Name", text: $name, prompt: Text("Who is this?"))
                            .onSubmit { model.people.rename(pid, name, failed: fail) }
                        TextField("Birthday", text: $birthday, prompt: Text("1952, 1952-03 or 1952-03-14"))
                            .keyboardType(.numbersAndPunctuation)
                            .onSubmit { model.people.setBirthday(pid, birthday, failed: fail) }
                    } footer: {
                        Text("A name someone else has joins the two: it's the same person. The name goes to the slides around theirs where the same face, or a face like it in the same clothes, is.")
                    }
                    Section("\(faces.count) slides") {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 76), spacing: 10)], spacing: 10) {
                            ForEach(faces, id: \.id) { f in
                                FaceImage(face: f, size: 72)
                                    .contextMenu {
                                        Button("Not \(d.label(pid))", systemImage: "person.crop.circle.badge.xmark") { model.people.remove(pid, faces: [f.id], failed: fail) }
                                        Button("Open the slide", systemImage: "photo") { Task { await model.open(f.tray); if let i = model.tray?.groups.firstIndex(where: { $0.id == f.slide }) { model.select(i) }; dismiss() } }
                                    }
                            }
                        }
                        .padding(.vertical, 6)
                    }
                    let others = d.ids.filter { $0 != pid && d.known($0) && !d.ignored($0) }.sorted { d.label($0) < d.label($1) }
                    Section {
                        if !others.isEmpty {
                            Menu("The same person as…") {
                                ForEach(others, id: \.self) { o in Button(d.label(o)) { model.people.merge(into: o, [pid], failed: fail); dismiss() } }
                            }
                        }
                        Toggle("Ignore", isOn: Binding(get: { d.ignored(pid) }, set: { model.people.setIgnored([pid], $0, failed: fail) }))
                    } footer: {
                        Text("Ignored: someone you don't know (a crowd, the other team). Their look-alikes on other slides stay ignored too.")
                    }
                }
                .formStyle(.grouped)
                .navigationTitle(d.label(pid))
                .onAppear { name = d.name(pid); birthday = d.people[pid]?["birthday"].flatMap { if case .string(let b) = $0 { return b }; return nil } ?? "" }
            } else {
                Text("This person joined someone else.").foregroundStyle(.secondary)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
    }
}
