import Foundation

/// Follows a redirect with the request as it was sent. An Immich behind a proxy that sends
/// http:// on to https:// answers 301/302, and URLSession follows those as a GET without the
/// body: the albums still load, but the v3 album search (`POST /search/metadata`) arrives as
/// "Cannot GET". Only on the same host, so the API key never goes anywhere else.
final class KeepRequestOnRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    static let shared = KeepRequestOnRedirect()

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest) async -> URLRequest? {
        guard var r = task.originalRequest, let url = request.url, url.host() == r.url?.host() else { return request }
        r.url = url
        return r
    }
}
