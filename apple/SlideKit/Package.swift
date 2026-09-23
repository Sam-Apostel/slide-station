// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "SlideKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "SlideKit", targets: ["SlideKit"])],
    targets: [
        .target(
            name: "SlideKit",
            // The pixel loops are plain Swift over buffers: unoptimised they are ~50x slower,
            // which makes a Debug build on the device unusable. Optimise them in every config.
            swiftSettings: [.unsafeFlags(["-O"], .when(configuration: .debug))]
        ),
        .testTarget(name: "SlideKitTests", dependencies: ["SlideKit"], resources: [.copy("Golden")]),
    ],
    swiftLanguageVersions: [.v5]
)
