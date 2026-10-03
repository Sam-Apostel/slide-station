#if DEBUG
import Foundation
#if os(iOS)
import UIKit
#endif

/// Launch-environment hooks for driving the app headlessly in the simulator (screenshots, CI).
/// DEBUG builds only. Pass with `SIMCTL_CHILD_<NAME>=… xcrun simctl launch …`:
///   SS_CARD_PATH   a folder to use as the scanner card instead of the Files bookmark
///   SS_LIBRARY_PATH  a library folder to use instead of the app's own (like one picked in Settings)
///   SS_AUTOIMPORT  import the card into a new tray with this name at launch (if there are no trays)
///   SS_OPEN        open the newest tray
///   SS_SELECT      select this slide index (or "end" for the finish line)
///   SS_STUDIO      1 = Studio mode, 0 = Simple mode
///   SS_IMMICH_URL / SS_IMMICH_KEY   Immich settings
///   SS_UPLOAD      after opening, upload the developed slides
///   SS_PLAY        play the followed albums' slideshow
///   SS_TOOL        open this tool of the phone layout (slides, frame, adjust, curve, scans, details, tray)
///   SS_ORIENTATION landscape: turn the interface on its side (the simulator can't be rotated from a script)
enum DebugLaunch {
    static let env = ProcessInfo.processInfo.environment
    static var cardPath: URL? { env["SS_CARD_PATH"].map { URL(fileURLWithPath: $0, isDirectory: true) } }
    static var libraryPath: URL? { env["SS_LIBRARY_PATH"].map { URL(fileURLWithPath: $0, isDirectory: true) } }

    @MainActor
    static func run(_ model: AppModel) async {
        #if os(iOS)
        if env["SS_ORIENTATION"] == "landscape",
           let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene {
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: .landscapeRight)) { _ in }
        }
        #endif
        if let s = env["SS_STUDIO"] { UserDefaults.standard.set(s == "1", forKey: "studio") }
        if let url = env["SS_IMMICH_URL"], let key = env["SS_IMMICH_KEY"] { model.immich = .init(url: url, key: key) }
        if let name = env["SS_AUTOIMPORT"], model.trays.isEmpty {
            model.importFromCard(name: name, date: env["SS_DATE"] ?? "")
            while model.busy { try? await Task.sleep(for: .milliseconds(200)) }
        }
        if env["SS_OPEN"] != nil, let first = model.trays.first {
            await model.open(first.id)
            if let sel = env["SS_SELECT"] {
                if sel == "end" { model.selection = model.tray?.groups.count ?? 0 } else if let i = Int(sel) { model.select(i) }
            }
            if env["SS_UPLOAD"] != nil { model.upload(onlyReady: true) }
        }
    }
}
#endif
