import XCTest
@testable import TDSocialCore

// A tap that starts the closed app must not be lost (dev job 64ee2a3f, 27 Nov 2026): before the fix the app opened on TD Talk whatever the alert was about.
final class PendingAlertTests: XCTestCase {
    private let allTabs = ["talk", "portal", "whatsapp", "inbox", "marketing"]
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    func testAPortalChatAlertOpensThePortalTabAndItsPage() {
        let t = AlertRouting.target(url: "/portal-chats?account=A1", thread: "admin-chat-A1", tabs: allTabs)
        XCTAssertEqual(t, AlertTarget(tab: "portal", path: "/portal-chats?account=A1"))
    }

    func testATeamChatAlertOpensTheTalkPageNotTheCrmTeamChat() {
        let t = AlertRouting.target(url: "/team-chat?thread=T1&message=M1", thread: nil, tabs: allTabs)
        XCTAssertEqual(t, AlertTarget(tab: "talk", path: "/talk?thread=T1&message=M1"))
    }

    func testWhatsAppAndEmailAlertsWithoutALinkUseTheirTag() {
        XCTAssertEqual(AlertRouting.target(url: nil, thread: "whatsapp:123", tabs: allTabs), AlertTarget(tab: "whatsapp", path: nil))
        XCTAssertEqual(AlertRouting.target(url: nil, thread: "email:support:abc", tabs: allTabs), AlertTarget(tab: "inbox", path: nil))
    }

    func testNoTargetWhenThePersonDoesNotHaveThatTab() {
        XCTAssertNil(AlertRouting.target(url: "/marketing/chat?lead=9", thread: nil, tabs: ["talk", "portal"]))
        XCTAssertNil(AlertRouting.target(url: "/portal-chats?account=A1", thread: nil, tabs: []))
    }

    func testNoTargetWhenTheAlertNamesNoTab() {
        XCTAssertNil(AlertRouting.target(url: nil, thread: "admin-test-notification", tabs: allTabs))
        XCTAssertNil(AlertRouting.target(url: nil, thread: nil, tabs: allTabs))
    }

    func testAnUnsafeLinkNeverBecomesAPage() {
        // the tab can still come from the tag, but a link to another site is never loaded
        let t = AlertRouting.target(url: "https://evil.example/portal-chats", thread: "whatsapp:1", tabs: allTabs)
        XCTAssertEqual(t, AlertTarget(tab: "whatsapp", path: nil))
    }

    func testAKeptTapIsUsedOnceTheTabsAreKnown() {
        let p = PendingAlert(url: "/portal-chats?account=A1", thread: "admin-chat-A1", receivedAt: t0)
        XCTAssertEqual(p.target(tabs: allTabs, now: t0.addingTimeInterval(3)), AlertTarget(tab: "portal", path: "/portal-chats?account=A1"))
    }

    func testAKeptTapSurvivesASlowSignInButNotALongWait() {
        let p = PendingAlert(url: "/portal-chats?account=A1", thread: nil, receivedAt: t0)
        XCTAssertTrue(p.isFresh(at: t0.addingTimeInterval(PendingAlert.lifetime)))
        XCTAssertNotNil(p.target(tabs: allTabs, now: t0.addingTimeInterval(PendingAlert.lifetime)))
        XCTAssertFalse(p.isFresh(at: t0.addingTimeInterval(PendingAlert.lifetime + 1)))
        XCTAssertNil(p.target(tabs: allTabs, now: t0.addingTimeInterval(PendingAlert.lifetime + 1)))
    }

    func testAClockMovedBackwardsDoesNotExpireTheTap() {
        let p = PendingAlert(url: "/portal-chats?account=A1", thread: nil, receivedAt: t0)
        XCTAssertTrue(p.isFresh(at: t0.addingTimeInterval(-30)))
    }

    func testTheLifetimeIsShortEnoughToBeSafe() {
        XCTAssertLessThanOrEqual(PendingAlert.lifetime, 600)
        XCTAssertGreaterThanOrEqual(PendingAlert.lifetime, 60)
    }

    func testAKeptTapForATabThePersonLacksIsDroppedNotApplied() {
        let p = PendingAlert(url: "/marketing/chat?lead=9", thread: nil, receivedAt: t0)
        XCTAssertNil(p.target(tabs: ["talk", "portal", "whatsapp", "inbox"], now: t0.addingTimeInterval(2)))
    }
}
