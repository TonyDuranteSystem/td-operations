import XCTest
@testable import TDClientCore

// An alert that arrives while the app is open refreshes the bar's numbers (dev job 056a70d0, 13 Nov 2026; docs/systems/client-app.md).
final class AlertRefreshTests: XCTestCase {
    func testTheBarIsAskedAtOnceAndAgainAfterTheChatHadTimeToMarkTheMessageRead() {
        XCTAssertEqual(AlertRefreshRules.delays.count, 2)
        XCTAssertEqual(AlertRefreshRules.delays.first, 0)
        let second = AlertRefreshRules.delays[1]
        XCTAssertGreaterThan(second, 1)   // longer than the chat page needs to mark a message read
        XCTAssertLessThanOrEqual(second, 10)
    }
    func testDelaysAreInOrder() {
        XCTAssertEqual(AlertRefreshRules.delays, AlertRefreshRules.delays.sorted())
    }
}
