import ProUI
import SlideFaces
import SlideKit
import SwiftUI

/// Who is on this slide (`components/slide-people.tsx`): its faces left to right; pick one to say
/// who it is (likeliest names first, someone new, "Not <name>"), or mark someone the finder missed.
struct SlidePeopleView: View {
    @Environment(AppModel.self) private var model
    let tray: Tray
    let slide: Slide
    @State private var query = ""
    @State private var showingPeople = false

    private var people: PeopleModel { model.people }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !people.enabled || !people.modelReady {
                turnOn
            } else {
                let faces = people.faces(tray, slide)
                if faces.isEmpty {
                    Text(people.finder.stale(tray: tray.id, slide: slide) ? "Looking for faces…" : "No faces found on this slide.")
                        .font(.system(size: 13)).foregroundStyle(ProTheme.muted)
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(alignment: .top, spacing: 12) {
                            ForEach(faces) { f in faceButton(f) }
                        }
                        .padding(.vertical, 2)
                    }
                }
                if let id = people.picked, let f = faces.first(where: { $0.id == id }) { picker(f) }
                HStack(spacing: 8) {
                    Button { people.marking.toggle(); people.picked = nil } label: {
                        Label(people.marking ? "Tap the photo where they are…" : "Mark someone it missed", systemImage: "person.crop.circle.badge.plus")
                    }
                    .buttonStyle(.plain).font(.system(size: 13, weight: .medium))
                    .foregroundStyle(people.marking ? ProTheme.accent : ProTheme.muted)
                    Spacer()
                    Button("All people…") { showingPeople = true }.buttonStyle(.plain).font(.system(size: 13)).foregroundStyle(ProTheme.accent)
                }
            }
        }
        .padding(14)
        .task(id: "\(slide.id)|\(slide.faceKey)|\(people.enabled)|\(people.modelReady)") {
            // what's picked belongs to a slide: keep it while this view is just shown again
            if let p = people.picked, !p.hasPrefix("\(tray.id)/\(slide.id)/") { people.picked = nil }
            if people.file == nil { await people.reload() }
            await people.findOnSlide(tray, slide)
        }
        .onChange(of: slide.id) { people.marking = false }
        .sheet(isPresented: $showingPeople) { PeopleScreen() }
    }

    private var turnOn: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Recognise the people on your slides: their faces are grouped across all your trays, and a name you give once goes to every slide they're on.")
                .font(.system(size: 13)).foregroundStyle(ProTheme.muted).fixedSize(horizontal: false, vertical: true)
            Text("It uses the desktop app's face model (\(FaceFinder.modelMB) MB, downloaded once into your library). Everything stays on this device.")
                .font(.system(size: 12)).foregroundStyle(ProTheme.dim).fixedSize(horizontal: false, vertical: true)
            Button {
                people.enabled = true
                model.findFaces(everyTray: false)
            } label: { Label(people.enabled ? "Download the face model" : "Recognise people", systemImage: "person.2.crop.square.stack") }
                .buttonStyle(BigButtonStyle(prominent: true)).disabled(model.busy)
        }
    }

    private func faceButton(_ f: PeopleModel.SlideFace) -> some View {
        let on = people.picked == f.id
        return Button {
            people.marking = false
            people.picked = on ? nil : f.id
            query = ""
        } label: {
            VStack(spacing: 5) {
                FaceImage(face: f.face, size: 56)
                    .overlay { Circle().strokeBorder(on ? ProTheme.accent : f.label == nil ? ProTheme.line : .clear, lineWidth: on ? 2.5 : 1) }
                Text(f.label ?? "Who?").font(.system(size: 11, weight: on ? .semibold : .regular)).lineLimit(1)
                    .foregroundStyle(f.label == nil ? ProTheme.muted : on ? ProTheme.accent : ProTheme.ink)
            }
            .frame(width: 64)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(f.label ?? "Someone not named yet")
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    /// Who is this? Likeliest names first; typing narrows them or makes someone new.
    private func picker(_ f: PeopleModel.SlideFace) -> some View {
        let fail: (String) -> Void = { model.error = $0 }
        let names = people.names(for: f.id, matching: query)
        let typed = query.trimmingCharacters(in: .whitespaces)
        return VStack(alignment: .leading, spacing: 6) {
            TextField(f.label.map { "Not \($0)? Type a name" } ?? "Who is this? Type a name", text: $query)
                .textFieldStyle(.plain).font(.system(size: 15))
                .padding(.horizontal, 10).padding(.vertical, 8)
                .background(SS.field, in: RoundedRectangle(cornerRadius: 7))
                .overlay { RoundedRectangle(cornerRadius: 7).strokeBorder(ProTheme.line, lineWidth: 1) }
                .autocorrectionDisabled()
                .onSubmit {
                    if let first = names.first, first.name.lowercased() == typed.lowercased() { people.assign(f.id, to: .person(first.pid), failed: fail) }
                    else if !typed.isEmpty { people.assign(f.id, to: .new(typed), failed: fail) }
                    query = ""
                }
            ForEach(names.prefix(6), id: \.pid) { n in
                Button { people.assign(f.id, to: .person(n.pid), failed: fail); query = "" } label: {
                    HStack {
                        Image(systemName: n.pid == f.person ? "checkmark.circle.fill" : "person.circle").foregroundStyle(n.pid == f.person ? ProTheme.accent : ProTheme.muted)
                        Text(n.name)
                        if n.likely && n.pid != f.person { Text("likely").font(.system(size: 10, weight: .semibold)).foregroundStyle(ProTheme.accent)
                            .padding(.horizontal, 5).padding(.vertical, 1).background(ProTheme.accent.opacity(0.14), in: Capsule()) }
                        Spacer()
                    }
                    .font(.system(size: 14)).padding(.vertical, 5).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            if !typed.isEmpty, !names.contains(where: { $0.name.lowercased() == typed.lowercased() }) {
                Button { people.assign(f.id, to: .new(typed), failed: fail); query = "" } label: {
                    Label("Someone new: “\(typed)”", systemImage: "person.badge.plus").font(.system(size: 14))
                }
                .buttonStyle(.plain).foregroundStyle(ProTheme.accent).padding(.vertical, 4)
            }
            HStack(spacing: 14) {
                if let name = f.label { Button("Not \(name)") { people.assign(f.id, to: .nobody, failed: fail) } }
                if f.face.manual { Button("Nobody there") { people.drop(f.id) } }
                if let pid = f.person, f.label == nil {
                    Button("Ignore") { people.setIgnored([pid], true, failed: fail); people.picked = nil }
                        .help("Someone you don't know: they stay out of the lists, and their look-alikes too")
                }
            }
            .buttonStyle(.plain).font(.system(size: 13, weight: .medium)).foregroundStyle(ProTheme.muted)
            .padding(.top, 2)
        }
        .padding(12)
        .background(SS.panel2.opacity(0.6), in: RoundedRectangle(cornerRadius: 10))
    }
}

/// The picked face outlined on the photo, and the tap that marks a face it missed. `box` is on the
/// upright, uncropped slide; the photo on the stage may be cropped (straightening and the trim
/// aren't followed: near enough to point, as the web app does).
struct FaceOverlay: View {
    @Environment(AppModel.self) private var model
    let tray: Tray
    let slide: Slide
    let cropped: Bool

    var body: some View {
        GeometryReader { geo in
            let crop = cropped ? slide.params.crop : nil
            let l = crop?[0] ?? 0, t = crop?[1] ?? 0, r = crop?[2] ?? 1, b = crop?[3] ?? 1
            if let id = model.people.picked, let f = model.people.faces(tray, slide).first(where: { $0.id == id }) {
                let x = (f.face.box[0] - l) / (r - l), y = (f.face.box[1] - t) / (b - t)
                let w = f.face.box[2] / (r - l), h = f.face.box[3] / (b - t)
                RoundedRectangle(cornerRadius: 4)
                    .strokeBorder(ProTheme.accent, lineWidth: 2)
                    .shadow(color: .black.opacity(0.6), radius: 3)
                    .frame(width: max(8, w * geo.size.width), height: max(8, h * geo.size.height))
                    .position(x: (x + w / 2) * geo.size.width, y: (y + h / 2) * geo.size.height)
                    .allowsHitTesting(false)
            }
            if model.people.marking {
                Color.clear.contentShape(Rectangle())
                    .onTapGesture { p in
                        let u = l + p.x / geo.size.width * (r - l), v = t + p.y / geo.size.height * (b - t)
                        model.people.mark(tray, slide, at: CGPoint(x: u, y: v)) { model.error = $0 }
                    }
            }
        }
    }
}
