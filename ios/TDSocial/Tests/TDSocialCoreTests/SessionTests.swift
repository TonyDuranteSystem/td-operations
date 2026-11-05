import XCTest
@testable import TDSocialCore

final class SessionTests: XCTestCase {
    // a real-shaped answer of GET /api/marketing/app/me (lib/app/me.ts), with a null count and a null badge case below
    let staffJSON = """
    {"ok":true,"user":{"id":"u1","email":"antonio.durante@tonydurante.us","name":"Antonio"},"loginKind":"staff",
     "tabs":[{"id":"talk","label":"TD Talk"},{"id":"portal","label":"Portal chats"},{"id":"whatsapp","label":"WhatsApp"},
             {"id":"inbox","label":"Inbox","mailboxes":["support","antonio"]},{"id":"marketing","label":"Marketing"}],
     "notSetUp":false,
     "prefs":{"mutedTabs":[],"whatsapp":true,"email":{"support":false,"antonio":false}},
     "counts":{"talk":2,"portal":0,"whatsapp":5,"inbox":null,"marketing":1},"badge":null}
    """

    func testASignedInAnswerIsUnderstood() throws {
        let state = SessionCheck.classify(status: 200, body: staffJSON.data(using: .utf8))
        guard case let .signedIn(me) = state else { return XCTFail("expected signedIn, got \(state)") }
        XCTAssertEqual(me.tabs.map(\.id), ["talk", "portal", "whatsapp", "inbox", "marketing"])
        XCTAssertEqual(me.tabs[3].mailboxes, ["support", "antonio"])
        XCTAssertEqual(me.prefs.whatsapp, true)
        XCTAssertEqual(me.prefs.email?["support"], false)
        XCTAssertNil(me.badge)
        XCTAssertEqual(me.count(for: "talk"), 2)
        XCTAssertEqual(me.count(for: "portal"), 0)
        XCTAssertEqual(me.count(for: "inbox"), 0, "a tab that could not be counted shows no number, never a made-up one")
        XCTAssertEqual(me.count(for: "nope"), 0)
        XCTAssertFalse(me.isMarketingOnly)
    }

    func testAMarketingLoginIsRecognised() throws {
        let json = #"{"ok":true,"user":{"id":"r","email":null,"name":"Rocco"},"loginKind":"marketing","tabs":[{"id":"marketing","label":"Marketing"}],"notSetUp":false,"prefs":{"mutedTabs":[]},"counts":null,"badge":3}"#
        guard case let .signedIn(me) = SessionCheck.classify(status: 200, body: json.data(using: .utf8)) else { return XCTFail("expected signedIn") }
        XCTAssertTrue(me.isMarketingOnly)
        XCTAssertEqual(me.badge, 3)
        XCTAssertNil(me.prefs.whatsapp)
    }

    func testNoSignInMeansTheSignInPage() {
        XCTAssertEqual(SessionCheck.classify(status: 401, body: Data("{\"code\":\"NOT_SIGNED_IN\"}".utf8)), .needsSignIn)
        for status in [301, 302, 303, 307, 308, 403] { XCTAssertEqual(SessionCheck.classify(status: status, body: nil), .needsSignIn, "\(status)") }
    }

    func testALoginPageSentInsteadOfAnswerIsNotASignIn() {
        XCTAssertEqual(SessionCheck.classify(status: 200, body: Data("<html>login</html>".utf8)), .needsSignIn)
        XCTAssertEqual(SessionCheck.classify(status: 200, body: nil), .needsSignIn)
        XCTAssertEqual(SessionCheck.classify(status: 200, body: Data("{\"ok\":false}".utf8)), .needsSignIn)
    }

    func testTheSwitchBeingOffIsSaidPlainly() {
        XCTAssertEqual(SessionCheck.classify(status: 503, body: Data("{\"error\":\"TD Social is not switched on yet.\",\"code\":\"APP_NOT_ENABLED\"}".utf8)), .notSwitchedOn)
        if case .failed = SessionCheck.classify(status: 503, body: Data("busy".utf8)) {} else { XCTFail("another 503 is a failure") }
    }

    func testOtherFailuresStayFailures() {
        if case .failed = SessionCheck.classify(status: -1, body: nil) {} else { XCTFail() }
        if case .failed = SessionCheck.classify(status: 500, body: nil) {} else { XCTFail() }
        if case .failed = SessionCheck.classify(status: 429, body: nil) {} else { XCTFail() }
    }

    func testPhoneRegistrationBodyMatchesTheServer() {
        let b = DeviceBody.registration(token: "ab12", bundleId: "com.tonydurante.tdsocial", apnsEnv: "production", deviceName: "Antonio's iPhone", appVersion: "0.1.0", appBuild: 7)
        XCTAssertEqual(b["token"] as? String, "ab12")
        XCTAssertEqual(b["bundleId"] as? String, "com.tonydurante.tdsocial")
        XCTAssertEqual(b["apnsEnv"] as? String, "production")
        XCTAssertEqual(b["appBuild"] as? Int, 7)
        XCTAssertEqual(Set(b.keys), ["token", "bundleId", "apnsEnv", "deviceName", "appVersion", "appBuild"])
    }

    func testTheTokenIsPlainLowercaseHex() {
        XCTAssertEqual(DeviceBody.hex(Data([0x00, 0x0f, 0xab, 0xff])), "000fabff")
        XCTAssertEqual(DeviceBody.hex(Data()), "")
    }
}
