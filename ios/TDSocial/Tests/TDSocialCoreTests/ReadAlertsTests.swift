import XCTest
@testable import TDSocialCore

final class ReadAlertsTests: XCTestCase {
    private func me(_ counts: [String: Int?]?) -> AppMe {
        AppMe(user: AppUser(id: "u", email: nil, name: "A"), loginKind: "staff", tabs: [AppTabInfo(id: "whatsapp", label: "WhatsApp")], counts: counts)
    }
    private let wa = ReadAlerts.Delivered(id: "1", url: nil, thread: "whatsapp:abc")
    private let talk = ReadAlerts.Delivered(id: "2", url: "/team-chat?thread=x", thread: "talk-x")
    private let unknown = ReadAlerts.Delivered(id: "3", url: nil, thread: "something-else")

    func testClearsOnlyTabsTheServerSaysAreRead() {
        XCTAssertEqual(ReadAlerts.idsToClear(delivered: [wa, talk, unknown], me: me(["whatsapp": 0, "talk": 3])), ["1"])
    }
    func testMissingOrFailedCountClearsNothing() {
        XCTAssertEqual(ReadAlerts.idsToClear(delivered: [wa, talk], me: me(nil)), [])
        XCTAssertEqual(ReadAlerts.idsToClear(delivered: [wa], me: me(["whatsapp": nil])), [])
        XCTAssertEqual(ReadAlerts.idsToClear(delivered: [wa], me: me([:])), [])
    }
    func testAnAlertOfNoKnownTabIsNeverRemoved() {
        XCTAssertEqual(ReadAlerts.idsToClear(delivered: [unknown], me: me(["whatsapp": 0, "talk": 0])), [])
    }
    func testSameThreadAsTheTappedAlert() {
        let other = ReadAlerts.Delivered(id: "4", url: nil, thread: "whatsapp:abc")
        XCTAssertEqual(ReadAlerts.idsOfSameThread(as: "whatsapp:abc", delivered: [wa, talk, other]), ["1", "4"])
        XCTAssertEqual(ReadAlerts.idsOfSameThread(as: nil, delivered: [wa]), [])
        XCTAssertEqual(ReadAlerts.idsOfSameThread(as: "", delivered: [wa]), [])
    }
}
