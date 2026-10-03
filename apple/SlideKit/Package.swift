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
        // People on your own slides: the desktop app's face models (YuNet, SFace) through ONNX
        // Runtime, the same faces.json / people.json, so a shared library stays one library.
        .library(name: "SlideFaces", targets: ["SlideFaces"]),
    ],
    dependencies: [
        .package(path: "../Vendor/ProUI"),
        .package(url: "https://github.com/microsoft/onnxruntime-swift-package-manager", exact: "1.24.2"),
    ],
    targets: [
        .target(
            name: "SlideKit",
            // The pixel loops are plain Swift over buffers: unoptimised they are ~50x slower,
            // which makes a Debug build on the device unusable. Optimise them in every config.
            swiftSettings: [.unsafeFlags(["-O"], .when(configuration: .debug))]
        ),
        .target(name: "SlideAlbums", dependencies: [.product(name: "ProUI", package: "ProUI")]),
        .target(
            name: "SlideFaces",
            dependencies: [
                "SlideKit",
                .product(name: "onnxruntime", package: "onnxruntime-swift-package-manager", condition: .when(platforms: [.iOS, .macOS])),
            ],
            resources: [.copy("Resources/face_detection_yunet_2023mar.onnx")],
            swiftSettings: [.unsafeFlags(["-O"], .when(configuration: .debug))]   // pixel loops, as SlideKit
        ),
        .testTarget(name: "SlideKitTests", dependencies: ["SlideKit"], resources: [.copy("Golden")]),
        .testTarget(name: "SlideAlbumsTests", dependencies: ["SlideAlbums"]),
        .testTarget(name: "SlideFacesTests", dependencies: ["SlideFaces"], resources: [.copy("Fixtures")]),
    ],
    swiftLanguageVersions: [.v5]
)
