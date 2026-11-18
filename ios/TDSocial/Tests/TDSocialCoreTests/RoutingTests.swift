import XCTest
@testable import TDSocialCore

final class RoutingTests: XCTestCase {
    func testEveryTabHasItsPage() {
        XCTAssertEqual(TabPath.path(for: "talk"), "/talk")
        XCTAssertEqual(TabPath.path(for: "portal"), "/portal-chats")
        XCTAssertEqual(TabPath.path(for: "whatsapp"), "/inbox?channel=whatsapp")
        XCTAssertEqual(TabPath.path(for: "inbox"), "/inbox")
        XCTAssertEqual(TabPath.path(for: "marketing"), "/marketing/chat")
        XCTAssertNil(TabPath.path(for: "made_up"))
        XCTAssertNil(TabPath.path(for: ""))
    }

    func testShortLabels() {
        XCTAssertEqual(TabPath.shortLabel(for: "portal", fallback: "Portal chats"), "Portal")
        XCTAssertEqual(TabPath.shortLabel(for: "unknown", fallback: "Something"), "Something")
    }

    func testUserAgentTokenIsTheServersExactToken() {
        // lib/app-mode/app-mode.ts on the server: token "TDSocial/", exact and case-sensitive
        XCTAssertEqual(ServerRules.userAgentToken, "TDSocial/")
    }

    func testAlertOpensTheRightTabFromItsLink() {
        XCTAssertEqual(AlertRouting.tab(url: "/talk?thread=abc", thread: nil), "talk")
        XCTAssertEqual(AlertRouting.tab(url: "/portal-chats?account=1", thread: nil), "portal")
        XCTAssertEqual(AlertRouting.tab(url: "/marketing/chat?lead=9", thread: nil), "marketing")
        XCTAssertEqual(AlertRouting.tab(url: "/inbox?channel=whatsapp&thread=whatsapp:x", thread: nil), "whatsapp")
        XCTAssertEqual(AlertRouting.tab(url: "/inbox", thread: nil), "inbox")
    }

    func testAlertWithoutLinkUsesTheTagPrefix() {
        XCTAssertEqual(AlertRouting.tab(url: nil, thread: "whatsapp:123"), "whatsapp")
        XCTAssertEqual(AlertRouting.tab(url: nil, thread: "email:support:abc"), "inbox")
        XCTAssertNil(AlertRouting.tab(url: nil, thread: "admin-test-notification"))
        XCTAssertNil(AlertRouting.tab(url: nil, thread: nil))
    }

    func testTheLinkWinsOverTheTag() {
        XCTAssertEqual(AlertRouting.tab(url: "/talk", thread: "whatsapp:1"), "talk")
    }

    // A TD Talk alert is sent as the CRM's Team Chat address; it must open the TD Talk tab (Antonio, 2026-11-17: the tap opened the app but nothing else).
    func testATeamChatLinkOpensTheTalkTab() {
        XCTAssertEqual(AlertRouting.tab(url: "/team-chat?thread=abc&message=m1", thread: "team-dm-abc"), "talk")
        XCTAssertEqual(AlertRouting.tab(url: "/team-chat", thread: nil), "talk")
        XCTAssertEqual(AlertRouting.tab(url: "/TEAM-CHAT?thread=abc", thread: nil), "talk")
        XCTAssertEqual(AlertRouting.tab(url: "/team-chat/x?thread=abc", thread: nil), "talk")
        // a longer word is not the Team Chat page
        XCTAssertNil(AlertRouting.tab(url: "/team-chatter?thread=abc", thread: nil))
    }

    // ...and the page that loads is TD Talk's, with the whole query kept (the message id included), never the CRM's Team Chat page inside the Talk tab.
    func testATeamChatLinkLoadsTheTalkPage() {
        XCTAssertEqual(AlertRouting.pagePath(url: "/team-chat?thread=abc&root=r1&message=m1"), "/talk?thread=abc&root=r1&message=m1")
        XCTAssertEqual(AlertRouting.pagePath(url: "/team-chat"), "/talk")
        XCTAssertEqual(AlertRouting.pagePath(url: "/team-chat#top"), "/talk#top")
        XCTAssertEqual(AlertRouting.pagePath(url: "/team-chat/old/path?thread=abc"), "/talk?thread=abc")
        // every other safe link is loaded as it is
        XCTAssertEqual(AlertRouting.pagePath(url: "/talk?thread=abc&message=m1"), "/talk?thread=abc&message=m1")
        XCTAssertEqual(AlertRouting.pagePath(url: "/portal-chats?account=1"), "/portal-chats?account=1")
        XCTAssertEqual(AlertRouting.pagePath(url: "/team-chatter?x=1"), "/team-chatter?x=1")
        // an unsafe link is never loaded
        XCTAssertNil(AlertRouting.pagePath(url: "https://evil.example/team-chat"))
        XCTAssertNil(AlertRouting.pagePath(url: "//evil.example/team-chat"))
        XCTAssertNil(AlertRouting.pagePath(url: nil))
    }

    func testAnUnsafeLinkIsNeverFollowed() {
        for bad in ["https://evil.example/x", "//evil.example", "javascript:alert(1)", "/a b", "/a\\b", "talk", "", "/x\u{0007}y"] {
            XCTAssertNil(AlertRouting.safeRelativePath(bad), bad)
        }
        XCTAssertNil(AlertRouting.safeRelativePath(nil))
        XCTAssertNil(AlertRouting.safeRelativePath("/" + String(repeating: "a", count: 600)))
        XCTAssertEqual(AlertRouting.safeRelativePath("/portal-chats?account=1"), "/portal-chats?account=1")
        // a bad link falls back to the tag
        XCTAssertEqual(AlertRouting.tab(url: "https://evil.example/talk", thread: "email:support:1"), "inbox")
    }

    func testOnlyOurOwnServerStaysInTheApp() {
        XCTAssertTrue(LinkRules.staysInApp(host: "crm.tonydurante.us", serverHost: "crm.tonydurante.us"))
        XCTAssertTrue(LinkRules.staysInApp(host: "CRM.tonydurante.us", serverHost: "crm.tonydurante.us"))
        XCTAssertFalse(LinkRules.staysInApp(host: "crm.tonydurante.us.evil.example", serverHost: "crm.tonydurante.us"))
        XCTAssertFalse(LinkRules.staysInApp(host: "example.com", serverHost: "crm.tonydurante.us"))
        XCTAssertFalse(LinkRules.staysInApp(host: nil, serverHost: "crm.tonydurante.us"))
    }
}
