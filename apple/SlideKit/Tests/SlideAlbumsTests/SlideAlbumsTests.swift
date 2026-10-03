import Foundation
@testable import SlideAlbums
import XCTest

final class ModelTests: XCTestCase {
    func testAlbumSharedByAnotherAccount() {
        let mine = ImmichAlbum(json: ["id": "a", "albumName": "Garda 1978", "assetCount": 36, "owner": ["id": "me", "name": "Sam"]], me: "me")
        XCTAssertEqual(mine?.sharedBy, nil)
        let theirs = ImmichAlbum(json: ["id": "b", "albumName": "", "ownerId": "dad", "owner": ["id": "dad", "name": "", "email": "dad@example.com"]], me: "me")
        XCTAssertEqual(theirs?.sharedBy, "dad@example.com")
        XCTAssertEqual(theirs?.name, "Untitled album")
        XCTAssertEqual(theirs?.count, 0)
    }

    func testPhotoFromAsset() throws {
        let p = try XCTUnwrap(AlbumPhoto(json: [
            "id": "x", "type": "IMAGE", "localDateTime": "1978-08-14T12:03:00.000Z", "width": 3000, "height": 2000,
            "exifInfo": ["description": "  Mum at the lake \n", "city": "Riva del Garda", "country": "Italy"],
        ], albumID: "a"))
        XCTAssertEqual(p.caption, "Mum at the lake")
        XCTAssertEqual(p.place, "Riva del Garda, Italy")
        XCTAssertEqual(p.aspect ?? 0, 1.5, accuracy: 1e-9)
        XCTAssertEqual(p.dateText, ImmichDate.text(ImmichDate.wallClock("1978-08-14T12:03:00")!))
        XCTAssertNil(AlbumPhoto(json: ["id": "v", "type": "VIDEO"], albumID: "a"))
        XCTAssertNil(AlbumPhoto(json: ["id": "t", "type": "IMAGE", "isTrashed": true], albumID: "a"))
    }

    func testPeopleFromImmichFacesAsFractions() throws {
        let p = try XCTUnwrap(AlbumPhoto(json: ["id": "x", "people": [
            ["id": "mum", "name": "Mum", "faces": [["imageWidth": 1000, "imageHeight": 500, "boundingBoxX1": 100, "boundingBoxY1": 50, "boundingBoxX2": 300, "boundingBoxY2": 250]]],
            ["id": "hidden", "name": "X", "isHidden": true, "faces": [["imageWidth": 10, "imageHeight": 10, "boundingBoxX1": 0, "boundingBoxY1": 0, "boundingBoxX2": 1, "boundingBoxY2": 1]]],
        ]], albumID: "a"))
        XCTAssertEqual(p.people?.map(\.id), ["mum"])
        XCTAssertEqual(p.people?.first?.box, [0.1, 0.1, 0.3, 0.5])
        XCTAssertNil(AlbumPhoto(json: ["id": "y"], albumID: "a")?.people, "no people key: unknown, not nobody")
    }

    func testAlbumPeopleCountPhotosAndPickTheBiggestFace() {
        let small = PhotoPerson(id: "mum", name: "Mum", box: [0, 0, 0.1, 0.1])
        let big = PhotoPerson(id: "mum", name: "Mum", box: [0, 0, 0.5, 0.5])
        let photos = [
            AlbumPhoto(id: "1", albumID: "a", people: [small, small]),          // twice in one photo: counts once
            AlbumPhoto(id: "2", albumID: "a", people: [big, PhotoPerson(id: "dad", name: "Dad", box: [0, 0, 0.2, 0.2])]),
            AlbumPhoto(id: "3", albumID: "a", people: [PhotoPerson(id: "anon", name: "", box: [0, 0, 1, 1])]),   // unnamed: left out
        ]
        let people = AlbumPerson.of(photos)
        XCTAssertEqual(people.map(\.name), ["Mum", "Dad"])
        XCTAssertEqual(people.first?.count, 2)
        XCTAssertEqual(people.first?.photoID, "2")
    }

    func testEXIFDimensionsTurnWithOrientation() {
        let p = AlbumPhoto(json: ["id": "x", "exifInfo": ["exifImageWidth": 3000, "exifImageHeight": 2000, "orientation": "6"]], albumID: "a")
        XCTAssertEqual(p?.width, 2000)
        XCTAssertEqual(p?.height, 3000)
    }

    func testWallClockIgnoresOffsets() {
        let a = ImmichDate.wallClock("1978-08-14T12:03:00.000Z")
        XCTAssertEqual(a, ImmichDate.wallClock("1978-08-14T12:03:00+02:00"))
        XCTAssertEqual(a, ImmichDate.wallClock("1978-08-14T12:03:00"))
        XCTAssertNil(ImmichDate.wallClock("1978-08"))
    }

    /// Uploader.photoDate: noon plus a minute per slide, on the 1st (month known) or 1 January (year).
    func testDatePrecisionFromSlideStationTimes() {
        let year = ImmichDate.text(ImmichDate.wallClock("1978-01-01T12:17:00")!)
        XCTAssertTrue(year.contains("1978"))
        XCTAssertFalse(year.contains("1 "), year)
        let month = ImmichDate.text(ImmichDate.wallClock("1978-08-01T12:05:00")!)
        XCTAssertFalse(month.contains("1 "), month)
        XCTAssertTrue(month.contains("1978"))
        // a camera's own time on the 1st is a real date
        let day = ImmichDate.text(ImmichDate.wallClock("1978-08-01T09:30:00")!)
        XCTAssertNotEqual(day, month)
    }

    func testSpan() {
        let p = ["1974-05-01T12:00:00", "1981-01-01T12:00:00", "1977-03-03T08:00:00"].enumerated().map {
            AlbumPhoto(id: "\($0.offset)", albumID: "a", taken: ImmichDate.wallClock($0.element))
        }
        XCTAssertEqual(ImmichDate.span(p), "1974 – 1981")
        XCTAssertEqual(ImmichDate.span(Array(p.prefix(1))), "1974")
        XCTAssertNil(ImmichDate.span([AlbumPhoto(id: "x", albumID: "a")]))
    }

    func testTrayOrderOldestFirstUndatedLast() {
        let photos = [("c", "1978-08-01T12:02:00"), ("u", nil), ("a", "1978-08-01T12:00:00"), ("b", "1978-08-01T12:01:00")]
            .map { AlbumPhoto(id: $0.0, albumID: "x", taken: $0.1.flatMap(ImmichDate.wallClock)) }
        XCTAssertEqual(AlbumClient.ordered(photos).map(\.id), ["a", "b", "c", "u"])
    }
}

final class RotationTests: XCTestCase {
    private func defaults() -> UserDefaults {
        let d = UserDefaults(suiteName: "rotation-\(UUID().uuidString)")!
        return d
    }

    private let photos = (0..<10).map { AlbumPhoto(id: "p\($0)", albumID: "a") }

    func testEveryPhotoOnceARound() {
        var r = Rotation(defaults: defaults())
        let first = r.next(4, of: photos) + r.next(4, of: photos) + r.next(2, of: photos)
        XCTAssertEqual(Set(first.map(\.id)).count, 10)
        let second = r.next(10, of: photos)
        XCTAssertEqual(Set(second.map(\.id)).count, 10)
    }

    func testKeepsItsPlaceWhenTheAlbumComesBackInAnotherOrder() {
        let d = defaults()
        var r = Rotation(defaults: d)
        let a = r.next(3, of: photos)
        var again = Rotation(defaults: d)
        let b = again.next(7, of: photos.reversed())
        XCTAssertEqual(Set((a + b).map(\.id)).count, 10)
    }

    func testFewerPhotosThanAsked() {
        var r = Rotation(defaults: defaults())
        XCTAssertEqual(r.next(6, of: Array(photos.prefix(2))).count, 2)
        XCTAssertEqual(r.next(6, of: []).count, 0)
    }
}

/// The client against canned answers: v3 album search with cursor paging, the shared albums call.
final class ClientTests: XCTestCase {
    final class Stub: URLProtocol {
        nonisolated(unsafe) static var answer: (URLRequest) -> (Int, Any) = { _ in (404, [:]) }
        nonisolated(unsafe) static var seen: [String] = []
        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func startLoading() {
            var r = request
            if r.httpBody == nil, let s = r.httpBodyStream {
                s.open(); var d = Data(); var buf = [UInt8](repeating: 0, count: 4096)
                while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; d.append(buf, count: n) }
                r.httpBody = d
            }
            Stub.seen.append("\(r.httpMethod ?? "") \(r.url!.path)\(r.url!.query.map { "?" + $0 } ?? "")")
            let (code, body) = Stub.answer(r)
            let data = (try? JSONSerialization.data(withJSONObject: body)) ?? Data()
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: r.url!, statusCode: code, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
        override func stopLoading() {}
    }

    private func client() throws -> AlbumClient {
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [Stub.self]
        return try AlbumClient(ImmichConnection(url: "immich.local:2283/api/", key: " k "), session: URLSession(configuration: c))
    }

    func testURLAsPeopleTypeIt() throws {
        XCTAssertEqual(try client().base.absoluteString, "http://immich.local:2283/api")
        XCTAssertThrowsError(try AlbumClient(ImmichConnection(url: "x", key: "")))
    }

    func testV3AlbumIsSearchedPageByPage() async throws {
        Stub.seen = []
        Stub.answer = { r in
            if r.url!.path.hasSuffix("/albums/al") { return (200, ["id": "al", "assetCount": 3]) }
            let body = (try? JSONSerialization.jsonObject(with: r.httpBody ?? Data())) as? [String: Any] ?? [:]
            if body["cursor"] == nil {
                return (200, ["assets": ["items": [["id": "2", "localDateTime": "1978-08-01T12:01:00.000Z"], ["id": "1", "localDateTime": "1978-08-01T12:00:00.000Z"]], "nextCursor": "c2"]])
            }
            XCTAssertEqual(body["cursor"] as? String, "c2")
            return (200, ["assets": ["items": [["id": "v", "type": "VIDEO"], ["id": "3", "localDateTime": "1978-08-01T12:02:00.000Z"]], "nextCursor": NSNull()]])
        }
        let photos = try await client().photos(in: "al")
        XCTAssertEqual(photos.map(\.id), ["1", "2", "3"])
        XCTAssertEqual(Stub.seen.filter { $0.contains("search") }.count, 2)
    }

    func testV2AlbumListsItsAssets() async throws {
        Stub.seen = []
        Stub.answer = { _ in (200, ["id": "al", "assetCount": 1, "assets": [["id": "only", "type": "IMAGE"]]]) }
        let photos = try await client().photos(in: "al")
        XCTAssertEqual(photos.map(\.id), ["only"])
        // the listing has no people: one search for them, not a second listing
        XCTAssertEqual(Stub.seen.filter { $0.contains("search") }.count, 1)
    }

    func testOwnAndSharedAlbums() async throws {
        Stub.answer = { r in
            r.url!.query == "shared=true"
                ? (200, [["id": "s", "albumName": "From Dad", "owner": ["id": "dad", "name": "Dad"]], ["id": "o", "albumName": "Mine shared", "owner": ["id": "me"]]])
                : (200, [["id": "o", "albumName": "Mine shared", "owner": ["id": "me"]]])
        }
        let albums = try await client().albums(me: "me")
        XCTAssertEqual(albums.map(\.id), ["o", "s"])
        XCTAssertEqual(albums.last?.sharedBy, "Dad")
    }

    func testPermissionErrorNamesWhatToGrant() async throws {
        Stub.answer = { _ in (403, ["message": "Missing required permission"]) }
        do { _ = try await client().albums(me: nil); XCTFail() } catch let e as AlbumError {
            XCTAssertEqual(e, .permission("/albums"))
            XCTAssertTrue(e.localizedDescription.contains("album.read"))
        }
    }

    /// One's own photo: Immich's favorite. Someone else's: a like on the album, and unstarring
    /// deletes that like (only the owner may change an asset).
    func testStarIsAFavoriteOnOwnPhotosAndALikeOnOthers() async throws {
        Stub.seen = []
        Stub.answer = { r in
            if r.httpMethod == "GET" { return (200, [["id": "act1", "assetId": "theirs", "type": "like", "user": ["id": "me"]]]) }
            return (200, [:])
        }
        let c = try client()
        try await c.star(AlbumPhoto(id: "mine", albumID: "al", owner: "me"), true, me: "me")
        try await c.star(AlbumPhoto(id: "theirs", albumID: "al", owner: "dad"), true, me: "me")
        try await c.star(AlbumPhoto(id: "theirs", albumID: "al", owner: "dad"), false, me: "me")
        XCTAssertEqual(Stub.seen, ["PUT /api/assets/mine", "POST /api/activities",
                                   "GET /api/activities?albumId=al&type=like&userId=me", "DELETE /api/activities/act1"])
    }

    func testLikedPhotosOfOthersReadAsStarred() async throws {
        Stub.answer = { r in
            if r.url!.path.hasSuffix("/activities") { return (200, [["id": "a", "assetId": "2", "type": "like", "user": ["id": "me"]]]) }
            return (200, ["id": "al", "assetCount": 3, "assets": [
                ["id": "1", "ownerId": "dad", "isFavorite": true], ["id": "2", "ownerId": "dad"], ["id": "3", "ownerId": "me", "isFavorite": true],
            ]])
        }
        let photos = try await client().photos(in: "al", me: "me")
        // dad's own favorite doesn't count for me; my like does; my own favorite does
        XCTAssertEqual(photos.map(\.starred), [false, true, true])
    }

    func testImageFallsBackToPreviewThenOriginal() async throws {
        Stub.seen = []
        Stub.answer = { r in r.url!.path.hasSuffix("/original") ? (200, ["fake": "jpeg"]) : (404, [:]) }
        let d = try await client().image("x", size: .fullsize)
        XCTAssertFalse(d.isEmpty)
        XCTAssertEqual(Stub.seen, ["GET /api/assets/x/thumbnail?size=fullsize", "GET /api/assets/x/thumbnail?size=preview", "GET /api/assets/x/original"])
    }
}
