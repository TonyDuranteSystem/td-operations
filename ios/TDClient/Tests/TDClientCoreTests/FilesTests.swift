import XCTest
@testable import TDClientCore

final class FileRulesTests: XCTestCase {
    func testAPdfAnImageAndAnOfficeFileOpenAsFiles() {
        XCTAssertTrue(FileRules.opensAsFile(mimeType: "application/pdf", contentDisposition: nil))
        XCTAssertTrue(FileRules.opensAsFile(mimeType: "Application/PDF; charset=binary", contentDisposition: nil))
        XCTAssertTrue(FileRules.opensAsFile(mimeType: "image/png", contentDisposition: nil))
        XCTAssertTrue(FileRules.opensAsFile(mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", contentDisposition: nil))
        XCTAssertTrue(FileRules.opensAsFile(mimeType: "application/octet-stream", contentDisposition: nil))
        XCTAssertTrue(FileRules.opensAsFile(mimeType: "text/csv", contentDisposition: nil))
    }

    func testOurOwnPagesStayPages() {
        XCTAssertFalse(FileRules.opensAsFile(mimeType: "text/html", contentDisposition: nil))
        XCTAssertFalse(FileRules.opensAsFile(mimeType: "text/html; charset=utf-8", contentDisposition: nil))
        XCTAssertFalse(FileRules.opensAsFile(mimeType: "application/json", contentDisposition: nil))
        XCTAssertFalse(FileRules.opensAsFile(mimeType: "text/plain", contentDisposition: nil))
        XCTAssertFalse(FileRules.opensAsFile(mimeType: nil, contentDisposition: nil))
        XCTAssertFalse(FileRules.opensAsFile(mimeType: "", contentDisposition: nil))
    }

    func testAnAttachmentHeaderMakesAnythingAFile() {
        XCTAssertTrue(FileRules.opensAsFile(mimeType: "text/html", contentDisposition: "attachment; filename=\"a.html\""))
        XCTAssertTrue(FileRules.opensAsFile(mimeType: nil, contentDisposition: "  Attachment"))
        XCTAssertFalse(FileRules.opensAsFile(mimeType: "text/html", contentDisposition: "inline"))
    }

    func testSafeNameKeepsTheTempFolderSafe() {
        XCTAssertEqual(FileRules.safeName("Invoice 5714.pdf", mimeType: "application/pdf"), "Invoice 5714.pdf")
        XCTAssertEqual(FileRules.safeName("../../etc/passwd", mimeType: nil), "_.._etc_passwd")
        XCTAssertEqual(FileRules.safeName("a/b\\c:d.pdf", mimeType: nil), "a_b_c_d.pdf")
        XCTAssertEqual(FileRules.safeName("", mimeType: "application/pdf"), "File.pdf")
        XCTAssertEqual(FileRules.safeName("  ", mimeType: nil), "File")
        XCTAssertEqual(FileRules.safeName(".hidden", mimeType: nil), "hidden")
        XCTAssertFalse(FileRules.safeName("x\u{0}y\nz.pdf", mimeType: nil).contains("\n"))
    }

    func testAPercentEncodedNameFromTheServerIsDecoded() {
        XCTAssertEqual(FileRules.safeName("QA%20Test%20correspondence.pdf", mimeType: "application/pdf"), "QA Test correspondence.pdf")
        XCTAssertEqual(FileRules.safeName("Fattura%20n%C2%B0%205714.pdf", mimeType: "application/pdf"), "Fattura n° 5714.pdf")
        // a decoded folder separator or control character is still made safe
        XCTAssertEqual(FileRules.safeName("a%2Fb%5Cc.pdf", mimeType: nil), "a_b_c.pdf")
        XCTAssertFalse(FileRules.safeName("x%0Ay.pdf", mimeType: nil).contains("\n"))
        XCTAssertEqual(FileRules.safeName("..%2F..%2Fetc%2Fpasswd", mimeType: nil), "_.._etc_passwd")
        // text that is not valid percent-encoding is kept as it came ("100% sure.pdf")
        XCTAssertEqual(FileRules.safeName("100% sure.pdf", mimeType: nil), "100% sure.pdf")
    }

    func testAMissingExtensionIsFilledFromTheType() {
        XCTAssertEqual(FileRules.safeName("attachment", mimeType: "application/pdf"), "attachment.pdf")
        XCTAssertEqual(FileRules.safeName("photo", mimeType: "image/jpeg"), "photo.jpg")
        XCTAssertEqual(FileRules.safeName("sheet", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), "sheet.xlsx")
        XCTAssertEqual(FileRules.safeName("blob", mimeType: "application/x-unknown"), "blob")
    }

    func testALongNameIsCutButKeepsItsExtension() {
        let long = String(repeating: "a", count: 300) + ".pdf"
        let n = FileRules.safeName(long, mimeType: nil)
        XCTAssertTrue(n.hasSuffix(".pdf"))
        XCTAssertLessThanOrEqual(n.count, 130)
    }
}
