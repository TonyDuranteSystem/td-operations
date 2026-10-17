import XCTest
@testable import TDStorageCore

final class PKCETests: XCTestCase {
    func testRFC7636Vector() {
        // the same vector the CRM's own unit test uses: both sides must agree or no sign-in can ever succeed
        XCTAssertEqual(PKCE.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }
    func testVerifierShapeAndUniqueness() {
        let a = PKCE.makeVerifier(), b = PKCE.makeVerifier()
        XCTAssertNotEqual(a, b)
        XCTAssertTrue((43...128).contains(a.count))
        XCTAssertNil(a.range(of: "[^A-Za-z0-9\\-._~]", options: .regularExpression))
        XCTAssertEqual(PKCE.challenge(for: a).count, 43)
    }
    func testCheckCodeMatchesTheServer() {
        // the CRM page shows this same code for this challenge (tests/unit/storage-app-tokens.test.ts computes it the same way)
        let code = PKCE.checkCode(for: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        XCTAssertEqual(code, "VYF9-RWG3")      // the value the TypeScript side computes for this challenge (tests/unit/storage-app-tokens.test.ts)
        XCTAssertEqual(code.count, 9)
        XCTAssertEqual(code, PKCE.checkCode(for: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"))
        XCTAssertNotEqual(code, PKCE.checkCode(for: "different-challenge-value-of-43-characters-xx"))
    }
}

final class ItemIDTests: XCTestCase {
    func testRoundTrip() {
        let ids: [ItemID] = [.root, .group("alabama"), .owner("o1"), .folder(owner: "o1", folder: "f1"), .file(owner: "o1", file: "x9")]
        for id in ids { XCTAssertEqual(ItemID(raw: id.raw), id) }
    }
    func testRejectsGarbage() {
        for bad in ["", "x", "g:", "o:", "d:o1", "d:o1:", "f:o1", "z:1:2"] { XCTAssertNil(ItemID(raw: bad), bad) }
    }
    func testIdsAreNeverNames() {
        XCTAssertEqual(ItemID.file(owner: "o1", file: "abc").raw, "f:o1:abc")   // a rename cannot change the id
    }
}

final class NameMapperTests: XCTestCase {
    func testSlashAndColon() {
        XCTAssertEqual(NameMapper.finderName(fromServer: "Invoice 1/2.pdf"), "Invoice 1:2.pdf")
        XCTAssertEqual(NameMapper.serverName(fromFinder: "Invoice 1:2.pdf"), "Invoice 1/2.pdf")
    }
    func testUnicodeForms() {
        let nfd = "Jose\u{0301}.pdf", nfc = "Jos\u{00E9}.pdf"
        XCTAssertEqual(NameMapper.serverName(fromFinder: nfd), nfc)          // Finder sends decomposed, the CRM keeps composed
        XCTAssertEqual(NameMapper.finderName(fromServer: nfd), nfc)
    }
    func testControlCharactersAndTrim() {
        XCTAssertEqual(NameMapper.serverName(fromFinder: "  a\u{0007}b.txt "), "ab.txt")
    }
    func testLength() {
        XCTAssertTrue(NameMapper.fitsFinder(String(repeating: "a", count: 255)))
        XCTAssertFalse(NameMapper.fitsFinder(String(repeating: "a", count: 256)))
        XCTAssertFalse(NameMapper.fitsFinder(String(repeating: "é", count: 128)))   // 256 bytes
        XCTAssertFalse(NameMapper.fitsFinder(""))
    }
    func testJunk() {
        for j in [".DS_Store", "._photo.jpg", "~$Letter.docx", ".~lock.a.odt#", "x.tmp", "movie.crdownload", "doc.pdf.part", "a.sb-1234-xyz", "Thumbs.db", "desktop.ini"] {
            XCTAssertTrue(NameMapper.isJunk(j), j)
        }
        for ok in ["Letter.docx", "tmp.pdf", "partial summary.pdf", "My notes.txt"] { XCTAssertFalse(NameMapper.isJunk(ok), ok) }
    }
}

final class ChangeSignalsTests: XCTestCase {
    private func ch(_ kind: ChangeKind, _ id: String, _ op: ChangeOp = .upsert, owner: String? = "o1", parent: String? = "p1", oldOwner: String? = nil, oldParent: String? = nil) -> AppChange {
        AppChange(kind: kind, id: id, op: op, ownerId: owner, parentId: parent, oldOwnerId: oldOwner, oldParentId: oldParent, name: "n")
    }
    func testNewFileRefreshesItsFolder() {
        let r = ChangeSignals.affected([ch(.file, "f1")])
        XCTAssertEqual(r.containers, [ItemID.folder(owner: "o1", folder: "p1").raw]); XCTAssertFalse(r.rootChanged)
    }
    func testMoveRefreshesBothPlaces() {
        let r = ChangeSignals.affected([ch(.file, "f1", parent: "new", oldParent: "old")])
        XCTAssertEqual(r.containers, [ItemID.folder(owner: "o1", folder: "new").raw, ItemID.folder(owner: "o1", folder: "old").raw])
    }
    func testMoveBetweenStorages() {
        let r = ChangeSignals.affected([ch(.folder, "d", owner: "o2", parent: "np", oldOwner: "o1", oldParent: "op")])
        XCTAssertEqual(r.containers, [ItemID.folder(owner: "o2", folder: "np").raw, ItemID.folder(owner: "o1", folder: "op").raw])
    }
    func testTopFolderParentIsTheOwnerItself() {
        XCTAssertEqual(ChangeSignals.affected([ch(.folder, "d", parent: nil)]).containers, [ItemID.owner("o1").raw])
    }
    func testOwnerChangeRefreshesTheTreeTop() {
        let r = ChangeSignals.affected([ch(.owner, "o1", parent: nil)])
        XCTAssertTrue(r.rootChanged); XCTAssertEqual(r.containers, [ItemID.owner("o1").raw])
    }
    func testDeleteRefreshesTheFolderItWasIn() {
        XCTAssertEqual(ChangeSignals.affected([ch(.file, "f1", .delete)]).containers, [ItemID.folder(owner: "o1", folder: "p1").raw])
    }
}

/// A fake network: lets a test say what the CRM answers, call by call.
final class StubProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) -> (Int, String))?
    nonisolated(unsafe) static var seen: [URLRequest] = []
    private static let lock = NSLock()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        StubProtocol.lock.lock(); StubProtocol.seen.append(request); StubProtocol.lock.unlock()
        let (code, body) = StubProtocol.handler?(request) ?? (500, "{}")
        let resp = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class APITests: XCTestCase {
    private let base = URL(string: "https://crm.example.test/")!
    private func session() -> URLSession {
        let cfg = URLSessionConfiguration.ephemeral; cfg.protocolClasses = [StubProtocol.self]; return URLSession(configuration: cfg)
    }
    private func pair(_ a: String, _ r: String) -> TokenPair { TokenPair(accessToken: a, refreshToken: r, expiresIn: 900, deviceId: "d1") }
    override func setUp() { StubProtocol.handler = nil; StubProtocol.seen = [] }
    private func tokenCalls() -> Int { StubProtocol.seen.filter { $0.url!.path.hasSuffix("/token") }.count }

    func testDecodesTheRealShapes() throws {
        let nav = #"{"groups":[{"key":"state-AL","label":"Alabama","section":"clients","owners":[{"id":"o1","kind":"company","label":"Acme LLC","status":null,"fileCount":3}]}]}"#
        let folder = #"{"owner":{"kind":"company","label":"Acme LLC","accountStatus":"Active","closed":false},"folder":{"id":"f0","name":"Acme LLC","kind":"root","locked":true},"folders":[{"id":"f1","name":"3. Tax","kind":"tax","locked":true}],"files":[{"id":"x1","name":"EIN.pdf","size":1200,"mimeType":"application/pdf","updatedAt":"2026-10-17T00:00:00Z","downloadable":false}]}"#
        let changes = #"{"changes":[{"kind":"file","id":"x1","op":"upsert","ownerId":"o1","parentId":"f1","oldOwnerId":null,"oldParentId":null,"name":"EIN.pdf"}],"cursor":"123.45","resync":false,"hasMore":false}"#
        XCTAssertEqual(try JSONDecoder().decode(NavigationResponse.self, from: Data(nav.utf8)).groups.first?.owners.first?.label, "Acme LLC")
        let f = try JSONDecoder().decode(FolderListing.self, from: Data(folder.utf8))
        XCTAssertEqual(f.files.first?.downloadable, false); XCTAssertEqual(f.folders.first?.locked, true)
        let c = try JSONDecoder().decode(ChangesPage.self, from: Data(changes.utf8))
        XCTAssertEqual(c.cursor, "123.45"); XCTAssertEqual(c.changes.first?.op, .upsert)
        let t = try JSONDecoder().decode(TokenPair.self, from: Data(#"{"access_token":"sa_at_x","refresh_token":"sa_rt_y","token_type":"Bearer","expires_in":900,"device_id":"d1"}"#.utf8))
        XCTAssertEqual(t.deviceId, "d1")
    }

    func testSendsTheBearerToken() async throws {
        StubProtocol.handler = { _ in (200, #"{"groups":[]}"#) }
        let api = StorageAPI(baseURL: base, store: MemoryTokenStore(pair("sa_at_A", "sa_rt_A")), session: session())
        _ = try await api.navigation()
        XCTAssertEqual(StubProtocol.seen.first?.value(forHTTPHeaderField: "Authorization"), "Bearer sa_at_A")
        XCTAssertEqual(StubProtocol.seen.first?.url?.path, "/api/storage-app/navigation")
    }

    func testA401TriggersOneRenewalAndOneRetry() async throws {
        let store = MemoryTokenStore(pair("sa_at_OLD", "sa_rt_OLD"))
        StubProtocol.handler = { req in
            if req.url!.path.hasSuffix("/token") { return (200, #"{"access_token":"sa_at_NEW","refresh_token":"sa_rt_NEW","token_type":"Bearer","expires_in":900,"device_id":"d1"}"#) }
            return req.value(forHTTPHeaderField: "Authorization") == "Bearer sa_at_NEW" ? (200, #"{"groups":[]}"#) : (401, #"{"error":"Not signed in."}"#)
        }
        let api = StorageAPI(baseURL: base, store: store, session: session())
        _ = try await api.navigation()
        XCTAssertEqual(store.load()?.refreshToken, "sa_rt_NEW")
        XCTAssertEqual(tokenCalls(), 1)
    }

    func testParallelCallsShareOneRenewal() async throws {
        let store = MemoryTokenStore(pair("sa_at_OLD", "sa_rt_OLD"))
        StubProtocol.handler = { req in
            if req.url!.path.hasSuffix("/token") { Thread.sleep(forTimeInterval: 0.3); return (200, #"{"access_token":"sa_at_NEW","refresh_token":"sa_rt_NEW","token_type":"Bearer","expires_in":900,"device_id":"d1"}"#) }
            return req.value(forHTTPHeaderField: "Authorization") == "Bearer sa_at_NEW" ? (200, #"{"groups":[]}"#) : (401, "{}")
        }
        let api = StorageAPI(baseURL: base, store: store, session: session())
        async let a = api.navigation(), b = api.navigation(), c = api.navigation()
        _ = try await (a, b, c)
        XCTAssertEqual(tokenCalls(), 1, "three parallel 401s must renew ONCE (a second renewal would read as a stolen token)")
    }

    func testRevokedDeviceClearsTheTokens() async {
        let store = MemoryTokenStore(pair("sa_at_OLD", "sa_rt_OLD"))
        StubProtocol.handler = { req in
            req.url!.path.hasSuffix("/token") ? (403, #"{"error":"device_revoked","error_description":"This device was signed out."}"#) : (401, "{}")
        }
        let api = StorageAPI(baseURL: base, store: store, session: session())
        do { _ = try await api.navigation(); XCTFail("should throw") } catch { XCTAssertEqual(error as? StorageAPIError, .deviceRevoked) }
        XCTAssertNil(store.load())
    }

    func testExpiredRefreshMeansApproveAgain() async {
        let store = MemoryTokenStore(pair("sa_at_OLD", "sa_rt_OLD"))
        StubProtocol.handler = { req in req.url!.path.hasSuffix("/token") ? (400, #"{"error":"invalid_grant"}"#) : (401, "{}") }
        let api = StorageAPI(baseURL: base, store: store, session: session())
        do { _ = try await api.navigation(); XCTFail("should throw") } catch { XCTAssertEqual(error as? StorageAPIError, .notSignedIn) }
        XCTAssertNil(store.load())
    }

    func testStatusMapping() async {
        let api = StorageAPI(baseURL: base, store: MemoryTokenStore(pair("sa_at_A", "sa_rt_A")), session: session())
        StubProtocol.handler = { _ in (404, #"{"error":"Not found."}"#) }
        do { _ = try await api.folder(owner: "o1"); XCTFail() } catch { XCTAssertEqual(error as? StorageAPIError, .notFound) }
        StubProtocol.handler = { _ in (500, #"{"error":"Something went wrong."}"#) }
        do { _ = try await api.folder(owner: "o1"); XCTFail() } catch { XCTAssertEqual(error as? StorageAPIError, .server(500, "Something went wrong.")) }
    }

    func testFolderQueryAndHead() async throws {
        StubProtocol.handler = { req in
            if req.url!.query?.contains("head=1") == true { return (200, #"{"cursor":"9.9"}"#) }
            return (200, #"{"owner":{"kind":"company","label":"A","accountStatus":null,"closed":false},"folder":null,"folders":[],"files":[]}"#)
        }
        let api = StorageAPI(baseURL: base, store: MemoryTokenStore(pair("sa_at_A", "sa_rt_A")), session: session())
        let head = try await api.head()
        XCTAssertEqual(head, "9.9")
        _ = try await api.folder(owner: "o1", folder: "f1")
        XCTAssertEqual(StubProtocol.seen.last?.url?.query?.contains("owner=o1"), true)
        XCTAssertEqual(StubProtocol.seen.last?.url?.query?.contains("folder=f1"), true)
    }
}

final class DisambiguatorTests: XCTestCase {
    func testUniqueNamesAreUntouched() {
        let r = Disambiguator.unique([(id: "a1", name: "Acme"), (id: "b2", name: "Beta")])
        XCTAssertEqual(r["a1"], "Acme"); XCTAssertEqual(r["b2"], "Beta")
    }
    func testDuplicatesAllGetAStableIdSuffix() {
        let r = Disambiguator.unique([(id: "3f9a1111", name: "Acme LLC"), (id: "77be2222", name: "acme llc"), (id: "c0de3333", name: "Other")])
        XCTAssertEqual(r["3f9a1111"], "Acme LLC (3f9a)")
        XCTAssertEqual(r["77be2222"], "acme llc (77be)")
        XCTAssertEqual(r["c0de3333"], "Other")
        // the same input in another order gives the same names
        let r2 = Disambiguator.unique([(id: "c0de3333", name: "Other"), (id: "77be2222", name: "acme llc"), (id: "3f9a1111", name: "Acme LLC")])
        XCTAssertEqual(r, r2)
    }
    func testExtensionStaysLast() {
        let r = Disambiguator.unique([(id: "aaaa1111", name: "Report.pdf"), (id: "bbbb2222", name: "Report.pdf")])
        XCTAssertEqual(r["aaaa1111"], "Report (aaaa).pdf")
    }
    func testIdsSharingAPrefixStillEndUpUnique() {
        let r = Disambiguator.unique([(id: "abcd0001", name: "X"), (id: "abcd0002", name: "X")])
        XCTAssertEqual(Set(r.values.map { $0.lowercased() }).count, 2)
    }
}
