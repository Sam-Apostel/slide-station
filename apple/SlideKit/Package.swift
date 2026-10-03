// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "SlideKit",
    platforms: [.iOS(.v17), .macOS(.v14), .tvOS(.v17)],
    products: [
        .library(name: "SlideKit", targets: ["SlideKit"]),
        // Looking at slides in Immich albums: the apps' Albums, the widget and Apple TV. No pixel
        // pipeline, so the widget and the TV app stay small.
        .library(name: "SlideAlbums", targets: ["SlideAlbums"]),
    ],
    dependencies: [.package(path: "../Vendor/ProUI")],
    targets: [
        .target(
            name: "SlideKit",
            // The pixel loops are plain Swift over buffers: unoptimised they are ~50x slower,
            // which makes a Debug build on the device unusable. Optimise them in every config.
            swiftSettings: [.unsafeFlags(["-O"], .when(configuration: .debug))]
        ),
        .target(name: "SlideAlbums", dependencies: [.product(name: "ProUI", package: "ProUI")]),
        .testTarget(name: "SlideKitTests", dependencies: ["SlideKit"], resources: [.copy("Golden")]),
        .testTarget(name: "SlideAlbumsTests", dependencies: ["SlideAlbums"]),
    ],
    swiftLanguageVersions: [.v5]
)
