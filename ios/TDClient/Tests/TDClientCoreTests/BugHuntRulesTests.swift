import XCTest
@testable import TDClientCore

// The rules added after the bug hunt of 10 Nov 2026 (docs/systems/client-app.md → "Bug-hunt fixes").
final class BugHuntRulesTests: XCTestCase {
    // finding 1: the app asks about the company the page shows
    func testSelectionQueryAcceptsPlainIdsAndNothing() {
        XCTAssertEqual(SelectionRules.query(from: "selection:account=0b9a-12ab"), "account=0b9a-12ab")
        XCTAssertEqual(SelectionRules.query(from: "selection:"), "")
        XCTAssertEqual(SelectionRules.query(from: "selection:account=abc&mode=partner"), "account=abc&mode=partner")
    }
    func testSelectionQueryRefusesAnythingElse() {
        XCTAssertNil(SelectionRules.query(from: "menu"))
        XCTAssertNil(SelectionRules.query(from: "selection:account=a b"))
        XCTAssertNil(SelectionRules.query(from: "selection:account=a/../b"))
        XCTAssertNil(SelectionRules.query(from: "selection:account=<script>"))
        XCTAssertNil(SelectionRules.query(from: "selection:" + String(repeating: "a", count: 201)))
    }
    func testMeAddressCarriesTheSelection() {
        XCTAssertEqual(SelectionRules.meAddress(selection: ""), "/api/portal/app/me")
        XCTAssertEqual(SelectionRules.meAddress(selection: "account=x1"), "/api/portal/app/me?account=x1")
    }

    // finding 3: only "nobody is signed in" or "switched off" removes the bar; a hiccup keeps it
    func testMeOutcomeKeepsTheBarOnAHiccup() {
        XCTAssertEqual(MeRules.outcome(status: 200), .signedIn)
        XCTAssertEqual(MeRules.outcome(status: 401), .signedOut)
        XCTAssertEqual(MeRules.outcome(status: 403), .signedOut)
        XCTAssertEqual(MeRules.outcome(status: 503), .off)
        XCTAssertEqual(MeRules.outcome(status: 500), .unavailable)
        XCTAssertEqual(MeRules.outcome(status: 502), .unavailable)
        XCTAssertEqual(MeRules.outcome(status: 429), .unavailable)
        XCTAssertEqual(MeRules.outcome(status: nil), .unavailable)
        XCTAssertTrue(MeOutcome.signedOut.clearsBar)
        XCTAssertTrue(MeOutcome.off.clearsBar)
        XCTAssertFalse(MeOutcome.unavailable.clearsBar)
        XCTAssertFalse(MeOutcome.signedIn.clearsBar)
    }

    // finding 11: TD Billing is the invoices page with ?tab=billing
    func testBarLightsTheRightButton() {
        XCTAssertTrue(BarRules.isActive(itemPath: "/portal/billing", currentPath: "/portal/invoices", currentTab: "billing"))
        XCTAssertFalse(BarRules.isActive(itemPath: "/portal/invoices", currentPath: "/portal/invoices", currentTab: "billing"))
        XCTAssertTrue(BarRules.isActive(itemPath: "/portal/invoices", currentPath: "/portal/invoices", currentTab: nil))
        XCTAssertTrue(BarRules.isActive(itemPath: "/portal/invoices", currentPath: "/portal/invoices/new", currentTab: nil))
        XCTAssertFalse(BarRules.isActive(itemPath: "/portal/billing", currentPath: "/portal/invoices", currentTab: nil))
        XCTAssertTrue(BarRules.isActive(itemPath: "/portal", currentPath: "/portal", currentTab: nil))
        XCTAssertFalse(BarRules.isActive(itemPath: "/portal", currentPath: "/portal/chat", currentTab: nil))
        XCTAssertTrue(BarRules.isActive(itemPath: "/portal/chat?topic=x", currentPath: "/portal/chat", currentTab: nil))
    }

    // finding 13: the app's own questions run only on our own server page
    func testRequestsRunOnlyOnOurServer() {
        XCTAssertTrue(PageRules.mayRunRequest(pageHost: "portal.tonydurante.us", serverHost: "portal.tonydurante.us"))
        XCTAssertTrue(PageRules.mayRunRequest(pageHost: "Portal.TonyDurante.us", serverHost: "portal.tonydurante.us"))
        XCTAssertFalse(PageRules.mayRunRequest(pageHost: "app.tonydurante.us", serverHost: "portal.tonydurante.us"))
        XCTAssertFalse(PageRules.mayRunRequest(pageHost: "checkout.stripe.com", serverHost: "portal.tonydurante.us"))
        XCTAssertFalse(PageRules.mayRunRequest(pageHost: nil, serverHost: "portal.tonydurante.us"))
    }

    // finding 9: the sign-in page
    func testLoginPath() {
        XCTAssertTrue(PageRules.isLoginPath("/portal/login"))
        XCTAssertTrue(PageRules.isLoginPath("/portal/login/"))
        XCTAssertFalse(PageRules.isLoginPath("/portal"))
        XCTAssertFalse(PageRules.isLoginPath("/portal/loginx"))
    }

    // finding 7: sign-out waits for the server unless there is nothing to tell
    func testSignOutWaitsForTheServer() {
        XCTAssertTrue(SignOutRules.mayEndSession(removalStatus: 200))
        XCTAssertTrue(SignOutRules.mayEndSession(removalStatus: 401))   // the session is already gone
        XCTAssertTrue(SignOutRules.mayEndSession(removalStatus: 404))
        XCTAssertTrue(SignOutRules.mayEndSession(removalStatus: 503))   // the app is switched off: no alerts are sent anyway
        XCTAssertFalse(SignOutRules.mayEndSession(removalStatus: nil))  // offline
        XCTAssertFalse(SignOutRules.mayEndSession(removalStatus: 500))
        XCTAssertFalse(SignOutRules.mayEndSession(removalStatus: 502))
        XCTAssertFalse(SignOutRules.mayEndSession(removalStatus: 429))
    }

    // finding 9: no asking again on every page change after a refusal
    func testRegistrationRetryWaits() {
        let now = Date()
        XCTAssertTrue(RegistrationRules.mayRetry(lastFailure: nil, now: now))
        XCTAssertFalse(RegistrationRules.mayRetry(lastFailure: now.addingTimeInterval(-30), now: now))
        XCTAssertTrue(RegistrationRules.mayRetry(lastFailure: now.addingTimeInterval(-601), now: now))
    }
}
