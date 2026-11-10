import XCTest
@testable import TDClientCore

final class RulesTests: XCTestCase {
    let portal = "portal.tonydurante.us"
    let sandbox = "td-operations-sandbox.vercel.app"

    func testBrowserNameTokenMatchesTheServer() {
        // lib/app-mode/app-mode.ts CLIENT_APP_UA_TOKEN = 'TDClient/' (exact, case-sensitive)
        XCTAssertEqual(ServerRules.userAgentToken, "TDClient/")
    }

    func testOurServerStaysInTheApp() {
        XCTAssertTrue(LinkRules.staysInApp(host: portal, serverHost: portal))
        XCTAssertTrue(LinkRules.staysInApp(host: "PORTAL.tonydurante.us", serverHost: portal))
        XCTAssertTrue(LinkRules.staysInApp(host: sandbox, serverHost: sandbox))
    }

    func testTheAppSiblingStaysOnlyOnTheLivePortal() {
        XCTAssertTrue(LinkRules.staysInApp(host: "app.tonydurante.us", serverHost: portal))
        XCTAssertFalse(LinkRules.staysInApp(host: "app.tonydurante.us", serverHost: sandbox))
    }

    func testStripeCardPageStaysButNotLookAlikes() {
        XCTAssertTrue(LinkRules.staysInApp(host: "checkout.stripe.com", serverHost: portal))
        XCTAssertTrue(LinkRules.staysInApp(host: "stripe.com", serverHost: portal))
        XCTAssertFalse(LinkRules.staysInApp(host: "stripe.com.evil.example", serverHost: portal))
        XCTAssertFalse(LinkRules.staysInApp(host: "notstripe.com", serverHost: portal))
        XCTAssertFalse(LinkRules.staysInApp(host: "evilstripe.com", serverHost: portal))
    }

    func testOtherSitesAndEmptyHostsOpenOutsideTheApp() {
        XCTAssertFalse(LinkRules.staysInApp(host: "example.com", serverHost: portal))
        XCTAssertFalse(LinkRules.staysInApp(host: "portal.tonydurante.us.evil.example", serverHost: portal))
        XCTAssertFalse(LinkRules.staysInApp(host: nil, serverHost: portal))
        XCTAssertFalse(LinkRules.staysInApp(host: "", serverHost: portal))
        XCTAssertFalse(LinkRules.staysInApp(host: "crm.tonydurante.us", serverHost: portal))
    }

    func testOnlyOurSiteMayUseTheMicrophone() {
        XCTAssertTrue(LinkRules.mayUseMedia(host: portal, serverHost: portal))
        XCTAssertFalse(LinkRules.mayUseMedia(host: "checkout.stripe.com", serverHost: portal))
        XCTAssertFalse(LinkRules.mayUseMedia(host: "example.com", serverHost: portal))
    }

    func testAlertAndMenuLinksMustBeSameSiteRelativePaths() {
        XCTAssertEqual(AlertRouting.safeRelativePath("/portal/chat"), "/portal/chat")
        XCTAssertEqual(AlertRouting.safeRelativePath("/portal/invoices?tab=billing"), "/portal/invoices?tab=billing")
        XCTAssertNil(AlertRouting.safeRelativePath(nil))
        XCTAssertNil(AlertRouting.safeRelativePath(""))
        XCTAssertNil(AlertRouting.safeRelativePath("https://example.com/x"))
        XCTAssertNil(AlertRouting.safeRelativePath("//example.com/x"))
        XCTAssertNil(AlertRouting.safeRelativePath("/\\example.com"))
        XCTAssertNil(AlertRouting.safeRelativePath("/a b"))
        XCTAssertNil(AlertRouting.safeRelativePath("/a\nb"))
        XCTAssertNil(AlertRouting.safeRelativePath("javascript:alert(1)"))
        XCTAssertNil(AlertRouting.safeRelativePath("/" + String(repeating: "a", count: 600)))
    }
}
