import XCTest
@testable import TDSocialCore

final class TabLoadingTests: XCTestCase {
    func testOnlyTheTabOnScreenLoadsAtOnce() {
        XCTAssertTrue(TabLoading.loadsAtOnce(tabId: "talk", selected: "talk"))
        for other in ["portal", "whatsapp", "inbox", "marketing"] {
            XCTAssertFalse(TabLoading.loadsAtOnce(tabId: other, selected: "talk"), other)
        }
    }

    func testNothingLoadsAtOnceWhenNoTabIsSelectedYet() {
        XCTAssertFalse(TabLoading.loadsAtOnce(tabId: "talk", selected: ""))
    }

    func testTheOthersWaitInTabBarOrder() {
        XCTAssertEqual(TabLoading.warmOrder(tabs: ["talk", "portal", "whatsapp", "inbox"], selected: "talk"), ["portal", "whatsapp", "inbox"])
        XCTAssertEqual(TabLoading.warmOrder(tabs: ["talk", "portal", "whatsapp", "inbox"], selected: "inbox"), ["talk", "portal", "whatsapp"])
    }

    func testAPersonWithOneTabHasNothingToWarm() {
        XCTAssertEqual(TabLoading.warmOrder(tabs: ["marketing"], selected: "marketing"), [])
        XCTAssertEqual(TabLoading.warmOrder(tabs: [], selected: ""), [])
    }

    func testTheFallbackIsLongerThanTheDelay() {
        XCTAssertGreaterThan(TabLoading.warmFallback, TabLoading.warmDelay)
        XCTAssertGreaterThan(TabLoading.warmDelay, 0)
    }
}
