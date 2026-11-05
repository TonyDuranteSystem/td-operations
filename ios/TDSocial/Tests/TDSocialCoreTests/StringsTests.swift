import XCTest
@testable import TDSocialCore

final class StringsTests: XCTestCase {
    func testEveryMessageExistsInBothLanguages() {
        for m in Msg.allCases {
            XCTAssertFalse(Strings.text(m, italian: false).isEmpty, "\(m) english")
            XCTAssertFalse(Strings.text(m, italian: true).isEmpty, "\(m) italian")
            XCTAssertNotEqual(Strings.text(m, italian: false), Strings.text(m, italian: true), "\(m) must really be translated")
        }
    }

    func testItalianIsChosenOnlyForAnItalianPhone() {
        XCTAssertTrue(Strings.isItalian(["it-IT", "en-US"]))
        XCTAssertTrue(Strings.isItalian(["it"]))
        XCTAssertFalse(Strings.isItalian(["en-US", "it-IT"]))
        XCTAssertFalse(Strings.isItalian([]))
    }

    func testTheSignedOutSheetPromisesUnsentMessagesAreKept() {
        XCTAssertTrue(Strings.text(.signedOutSheet, italian: false).contains("unsent messages are kept"))
    }

    func testTheLockScreenPromiseIsTheApprovedOne() {
        XCTAssertEqual(Strings.text(.alertsBody, italian: false), "The lock screen shows who wrote, never what.")
    }
}

final class InitialsTests: XCTestCase {
    func testInitials() {
        XCTAssertEqual(Initials.of(name: "Antonio Durante", email: nil), "AD")
        XCTAssertEqual(Initials.of(name: "Luca", email: "luca@x.us"), "L")
        XCTAssertEqual(Initials.of(name: "Maria Elena Rossi", email: nil), "ME")
        XCTAssertEqual(Initials.of(name: "  ", email: "jodi@tonydurante.us"), "J")
        XCTAssertEqual(Initials.of(name: "", email: nil), "?")
    }
}
