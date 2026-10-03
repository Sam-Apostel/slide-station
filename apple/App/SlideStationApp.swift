import ProUI
import SlideAlbums
import SlideKit
import SwiftUI
#if os(iOS)
import WidgetKit
#endif

@main
struct SlideStationApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environment(model.albums)
                .preferredColorScheme(.dark)
                .tint(ProTheme.accent)
                .task {
                    #if os(iOS)
                    // the widget shows the followed albums: tell it when they change
                    model.albums.onChange = { WidgetCenter.shared.reloadAllTimelines() }
                    #endif
                    await model.refresh(); await model.checkCard()
                    await model.albums.refresh()
                    #if DEBUG
                    await DebugLaunch.run(model)
                    #endif
                }
                .onChange(of: phase) { _, now in
                    // the Mac may have changed a shared library meanwhile
                    if now == .active { Task { await model.refresh(); await model.checkCard(); await model.albums.refresh() } }
                }
                #if os(macOS)
                .frame(minWidth: 980, minHeight: 640)
                #endif
        }
        #if os(macOS)
        .defaultSize(width: 1440, height: 900)
        .commands { SlideCommands(model: model) }
        #endif
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("studio") private var studio = Platform.studioDefault
    @Environment(\.horizontalSizeClass) private var width
    @Environment(\.verticalSizeClass) private var height
    /// A photo the widget was showing when it was tapped.
    @State private var opened: AlbumSlideshow?

    var body: some View {
        @Bindable var model = model
        ZStack(alignment: .bottom) {
            ProTheme.background.ignoresSafeArea()
            if model.tray != nil {
                if !studio {
                    SimpleReviewView()
                } else if height == .compact {
                    CompactStudioView(landscape: true)    // a phone on its side
                } else if width == .compact {
                    CompactStudioView(landscape: false)   // a phone upright, a narrow iPad window
                } else {
                    StudioView()
                }
            } else {
                HomeView()
            }
            if !(studio && model.tray != nil && (width == .compact || height == .compact)) { JobBanner() }
        }
        .onOpenURL { url in opened = AlbumSlideshow(url: url, library: model.albums) }
        #if DEBUG
        .task(id: model.albums.followedPhotos.count) {   // SS_PLAY=1: the followed albums' slideshow
            try? await Task.sleep(for: .seconds(2))   // after SS_ORIENTATION has turned the screen
            if DebugLaunch.env["SS_PLAY"] != nil, opened == nil, !model.albums.followedPhotos.isEmpty {
                opened = AlbumSlideshow(photos: model.albums.followedPhotos, title: model.albums.followedAlbums.first?.name, shuffle: false)
            }
        }
        #endif
        .fullScreenCover(item: $opened) { show in AppSlideshow(show: show) { opened = nil } }
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
