// swift-tools-version: 5.9
import PackageDescription

// Slide Station: trimmed to the components the app uses (see NOTICE.md) — no resources.
let package = Package(
    name: "ProUI",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.library(name: "ProUI", targets: ["ProUI"])],
    targets: [.target(name: "ProUI")],
    swiftLanguageVersions: [.v5]
)
