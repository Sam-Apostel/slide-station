import Foundation
import Security

/// An Immich server and an API key for it.
public struct ImmichConnection: Codable, Equatable, Sendable {
    public var url: String
    public var key: String
    public init(url: String = "", key: String = "") { self.url = url; self.key = key }
    public var isComplete: Bool { !url.trimmingCharacters(in: .whitespaces).isEmpty && !key.trimmingCharacters(in: .whitespaces).isEmpty }
}

/// The Immich server and API key, as one Keychain item.
///
/// - Synced with iCloud Keychain: the iPhone, iPad, Mac and Apple TV of one Apple ID all get it once
///   it's typed on any of them (nobody types an API key with a TV remote twice).
/// - In the access group `SSKeychainGroup` names in Info.plist (`$(AppIdentifierPrefix)land.sams.slide-station`),
///   which the apps and the widget share.
///
/// An unsigned build (the simulator without a team) has no access group and no iCloud: the item
/// then stays in the app's own keychain on this device, and the widget asks to open the app.
public enum ImmichKeychain {
    static let service = "land.sams.slide-station.immich"
    static let account = "connection"

    /// The shared access group, or nil when the build doesn't carry one.
    static var group: String? {
        guard let g = Bundle.main.object(forInfoDictionaryKey: "SSKeychainGroup") as? String,
              !g.isEmpty, !g.hasPrefix("."), !g.hasPrefix("$") else { return nil }
        return g
    }

    private static func base(group: String?) -> [CFString: Any] {
        var q: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account]
        if let group { q[kSecAttrAccessGroup] = group }
        #if os(macOS)
        q[kSecUseDataProtectionKeychain] = true   // the iOS-style keychain: access groups and iCloud sync
        #endif
        return q
    }

    public static func load() -> ImmichConnection? {
        for group in [group, nil] {
            var q = base(group: group)
            q[kSecReturnData] = true
            q[kSecMatchLimit] = kSecMatchLimitOne
            q[kSecAttrSynchronizable] = kSecAttrSynchronizableAny
            var out: CFTypeRef?
            if SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data,
               let c = try? JSONDecoder().decode(ImmichConnection.self, from: data) {
                return c
            }
        }
        return nil
    }

    /// Save (or with an incomplete connection, remove) the server and key everywhere.
    @discardableResult
    public static func save(_ c: ImmichConnection) -> Bool {
        // without a group the query matches the item in every group this app can reach
        var q = base(group: nil)
        q[kSecAttrSynchronizable] = kSecAttrSynchronizableAny
        SecItemDelete(q as CFDictionary)
        guard c.isComplete, let data = try? JSONEncoder().encode(c) else { return true }
        // best first: shared with the widget and synced; then whatever this build is entitled to
        var attempts: [(String?, Bool)] = [(nil, true), (nil, false)]
        if let group { attempts.insert(contentsOf: [(group, true), (group, false)], at: 0) }
        for (group, sync) in attempts {
            var add = base(group: group)
            add[kSecValueData] = data
            add[kSecAttrSynchronizable] = sync
            add[kSecAttrAccessible] = sync ? kSecAttrAccessibleAfterFirstUnlock : kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            add[kSecAttrLabel] = "Slide Station: Immich server"
            if SecItemAdd(add as CFDictionary, nil) == errSecSuccess { return true }
        }
        return false
    }
}

/// What the app shares with its widget: the App Group's defaults and folder. Outside an App Group
/// (the Mac and TV apps, an unsigned build) the app's own.
public enum SharedStore {
    public static let appGroup = "group.land.sams.slide-station"

    public static let defaults: UserDefaults = {
        #if os(iOS)
        if FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) != nil,
           let d = UserDefaults(suiteName: appGroup) { return d }
        #endif
        return .standard
    }()

    /// Where album lists and images are cached. Caches only: everything here comes back from Immich.
    public static let folder: URL = {
        #if os(iOS)
        if let c = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) {
            return c.appendingPathComponent("Library/Caches/Albums", isDirectory: true)
        }
        #endif
        return FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("Albums", isDirectory: true)
    }()

    /// The albums whose photos the slideshow, the widget and the TV show, in the order chosen.
    public static var followed: [String] {
        get { defaults.stringArray(forKey: "followedAlbums") ?? [] }
        set { defaults.set(newValue, forKey: "followedAlbums") }
    }

    /// Whether albums were ever chosen (an empty choice is a choice: don't follow shared albums again).
    public static var choseAlbums: Bool {
        get { defaults.bool(forKey: "choseAlbums") }
        set { defaults.set(newValue, forKey: "choseAlbums") }
    }
}
