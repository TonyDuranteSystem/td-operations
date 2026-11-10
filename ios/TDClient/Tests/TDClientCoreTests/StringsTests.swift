import XCTest
@testable import TDClientCore

final class StringsTests: XCTestCase {
    func testEveryMessageExistsInBothLanguages() {
        for m in Msg.allCases {
            XCTAssertFalse(Strings.text(m, italian: false).isEmpty, "\(m) has no English text")
            XCTAssertFalse(Strings.text(m, italian: true).isEmpty, "\(m) has no Italian text")
        }
    }

    func testItalianIsReallyTranslatedWhereTheWordsDiffer() {
        XCTAssertNotEqual(Strings.text(.signOut, italian: false), Strings.text(.signOut, italian: true))
        XCTAssertNotEqual(Strings.text(.alertsBody, italian: false), Strings.text(.alertsBody, italian: true))
        XCTAssertNotEqual(Strings.text(.tryAgain, italian: false), Strings.text(.tryAgain, italian: true))
    }

    func testPhoneLanguagePicksItalianOnlyWhenItIsTheFirstChoice() {
        XCTAssertTrue(Strings.isItalian(["it-IT", "en-US"]))
        XCTAssertTrue(Strings.isItalian(["it"]))
        XCTAssertFalse(Strings.isItalian(["en-US", "it-IT"]))
        XCTAssertFalse(Strings.isItalian([]))
    }

    func testTheAlertWordingNeverPromisesToShowTheDetails() {
        // approved design: the lock screen shows who and what kind, never what (the server's fixed wording)
        XCTAssertTrue(Strings.text(.alertsBody, italian: false).contains("never the details"))
        XCTAssertTrue(Strings.text(.alertsBody, italian: true).contains("mai i dettagli"))
    }
}
