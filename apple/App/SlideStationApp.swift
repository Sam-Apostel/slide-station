import ProUI
import SlideKit
import SwiftUI

@main
struct SlideStationApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(.dark)
                .tint(ProTheme.accent)
                .task {
                    await model.refresh(); await model.checkCard()
                    #if DEBUG
                    await DebugLaunch.run(model)
                    #endif
                }
                .onChange(of: phase) { _, now in
                    // the Mac may have changed a shared library meanwhile
                    if now == .active { Task { await model.refresh(); await model.checkCard() } }
                }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("studio") private var studio = false
    @Environment(\.horizontalSizeClass) private var width

    var body: some View {
        @Bindable var model = model
        ZStack(alignment: .bottom) {
            ProTheme.background.ignoresSafeArea()
            if model.tray != nil {
                if studio && width == .regular { StudioView() } else { SimpleReviewView() }
            } else {
                HomeView()
            }
            JobBanner()
        }
        .animation(.snappy, value: model.job == nil)
        .alert("Something went wrong", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("OK") { model.error = nil }
        } message: { Text(model.error ?? "") }
        .overlay(alignment: .top) {
            if let notice = model.notice {
                Text(notice).font(.system(size: 14, weight: .medium))
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(ProTheme.panel, in: Capsule())
                    .overlay { Capsule().strokeBorder(ProTheme.line, lineWidth: 1) }
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .task(id: notice) { try? await Task.sleep(for: .seconds(4)); model.notice = nil }
                    .onTapGesture { model.notice = nil }
            }
        }
        .animation(.snappy, value: model.notice)
    }
}
