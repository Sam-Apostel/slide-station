import SwiftUI

public extension Color {
    init(proHex: UInt32, opacity: Double = 1) {
        self.init(.sRGB, red: Double((proHex >> 16) & 255) / 255,
                  green: Double((proHex >> 8) & 255) / 255,
                  blue: Double(proHex & 255) / 255, opacity: opacity)
    }
}

/// The sRGB material values from pro-theme.css and shadcn-theme.css.
///
/// Slide Station: restyled to the app's skin (`frontend/src/theme.css`) — near-black cool
/// surfaces, warm off-white text, amber primary with dark ink. The surface tokens below replace
/// greys that were hardcoded in the controls, so the whole kit follows this one table.
public enum ProTheme {
    public static let accent = Color(proHex: 0xf2b34b)
    /// Text on the accent (amber wants dark ink, not white).
    public static let accentInk = Color(proHex: 0x1a1305)
    /// `--pro-text-selection`: the accent at 40 % behind selected text.
    public static let textSelection = Color(proHex: 0xf2b34b, opacity: 0.4)
    public static let ink = Color(proHex: 0xebe8e2)
    public static let muted = Color(proHex: 0x9b978e)
    public static let mutedForeground = Color(proHex: 0x9b978e)
    public static let dim = Color(proHex: 0x6f6c66)
    public static let bar = Color(proHex: 0x131316)
    public static let panel = Color(proHex: 0x16161a)
    public static let canvas = Color(proHex: 0x111114)
    public static let well = Color(proHex: 0x0a0a0b)
    public static let line = Color(proHex: 0x2a2a31)
    public static let lineSoft = Color(proHex: 0x202026)
    /// The dark seam between stacked panels and headers.
    public static let seam = Color(proHex: 0x08080a)
    public static let green = Color(proHex: 0x6cc28a)
    public static let warn = Color(proHex: 0xe8a13a)
    public static let background = Color(proHex: 0x0e0e10)
    public static let card = Color(proHex: 0x16161a)
    public static let popover = Color(proHex: 0x16161a)
    public static let border = Color(proHex: 0x2a2a31)
    public static let input = Color(proHex: 0x0c0c0e)
    public static let destructive = Color(proHex: 0xe2675c)
    public static let chart: [Color] = [0x54aaff, 0x81c798, 0xd5ad72, 0xb59ada, 0xe58b91].map { Color(proHex: $0) }
}

public extension View {
    /// Applies the package's compact typography and dark color scheme.
    func proTheme() -> some View {
        self.font(.system(size: 11)).foregroundStyle(ProTheme.ink)
            .tint(ProTheme.accent).preferredColorScheme(.dark)
    }
}
