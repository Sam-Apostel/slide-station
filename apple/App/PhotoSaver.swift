import Foundation
import Photos

/// Copies into the Photos library (add-only access: Slide Station never reads the library).
enum PhotoSaver {
    struct Denied: LocalizedError {
        var errorDescription: String? { "Slide Station may not add photos to your library. Allow it in Settings → Privacy & Security → Photos." }
    }

    static func authorize() async throws {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else { throw Denied() }
    }

    /// One photo's bytes as a new asset, under its own file name.
    static func save(_ data: Data, filename: String?) async throws {
        try await PHPhotoLibrary.shared().performChanges {
            let options = PHAssetResourceCreationOptions()
            options.originalFilename = filename
            PHAssetCreationRequest.forAsset().addResource(with: .photo, data: data, options: options)
        }
    }
}
