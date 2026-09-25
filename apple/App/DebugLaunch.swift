#if DEBUG
import Foundation

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
enum DebugLaunch {
    static let env = ProcessInfo.processInfo.environment
    static var cardPath: URL? { env["SS_CARD_PATH"].map { URL(fileURLWithPath: $0, isDirectory: true) } }
    static var libraryPath: URL? { env["SS_LIBRARY_PATH"].map { URL(fileURLWithPath: $0, isDirectory: true) } }

    @MainActor
    static func run(_ model: AppModel) async {
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
