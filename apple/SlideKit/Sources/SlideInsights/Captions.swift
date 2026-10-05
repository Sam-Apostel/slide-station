import CoreGraphics
import Foundation
import SlideKit
#if canImport(FoundationModels)
@_weakLinked import FoundationModels
#endif

/// A one-sentence description of a slide from Apple Intelligence's on-device model, instead of the
/// desktop's Florence-2 download (captions.py). A suggestion like the desktop's: accepted (or
/// edited) into the slide's caption, which goes to Immich as the description. Needs a device with
/// Apple Intelligence turned on, on iOS / macOS 27 (the model that sees pictures).
public enum Captions {
    public static let modelID = "apple-intelligence-caption"
    public static let maxChars = 200   // captions.MAX_CHARS

    public enum Availability: Equatable, Sendable {
        case ready
        case notEnabled      // Apple Intelligence is off in Settings
        case downloading     // its model is still coming
        case unsupported     // this device or system can't
    }

    public static var availability: Availability {
        #if canImport(FoundationModels) && !os(tvOS)
        if #available(iOS 27, macOS 27, *) {
            let m = SystemLanguageModel.default
            guard m.capabilities.contains(.vision) else { return .unsupported }
            switch m.availability {
            case .available: return .ready
            case .unavailable(.appleIntelligenceNotEnabled): return .notEnabled
            case .unavailable(.modelNotReady): return .downloading
            default: return .unsupported
            }
        }
        #endif
        return .unsupported
    }

    static let instructions = """
        You write captions for old family slides (photos). One short, factual sentence saying what \
        is in the photo, like a caption in a photo album. Don't guess names, places or dates unless \
        they are written in the photo. Don't start with "This photo" or "The image".
        """

    /// The caption for an upright picture, or nil when the model can't (not available, or it
    /// declined the picture).
    public static func caption(_ image: CGImage) async throws -> Insights.Suggestion? {
        #if canImport(FoundationModels) && !os(tvOS)
        if #available(iOS 27, macOS 27, *), availability == .ready {
            let session = LanguageModelSession(instructions: instructions)
            do {
                let r = try await session.respond(options: GenerationOptions(temperature: 0)) {
                    "Write the caption for this photo."
                    Attachment(image)
                }
                let text = tidy(r.content)
                return text.isEmpty ? nil : Insights.Suggestion(value: text, confidence: 0.5, source: modelID)
            } catch let e as LanguageModelSession.GenerationError {
                if case .guardrailViolation = e { return nil }   // a picture it won't describe: no suggestion
                if case .refusal = e { return nil }
                throw e
            }
        }
        #endif
        return nil
    }

    /// One sentence, no quotes or trailing spaces, at most 200 characters (captions.tidy).
    public static func tidy(_ s: String) -> String {
        var t = s.split(whereSeparator: \.isWhitespace).joined(separator: " ").trimmingCharacters(in: CharacterSet(charactersIn: "\"“”' "))
        if t.count > maxChars {
            let cut = t.prefix(maxChars)
            t = cut.lastIndex(of: " ").map { String(cut[..<$0]) } ?? String(cut)
        }
        if let f = t.first, f.isLowercase { t = f.uppercased() + t.dropFirst() }
        return t
    }
}
