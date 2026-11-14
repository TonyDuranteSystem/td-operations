package com.tonydurante.myllcmanager.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// A port of FilesTests.swift and StringsTests.swift (ios/TDClient/Tests/TDClientCoreTests).
class FileRulesTest {
    @Test fun safeNameKeepsTheTempFolderSafe() {
        assertEquals("Invoice 5714.pdf", FileRules.safeName("Invoice 5714.pdf", "application/pdf"))
        assertEquals("_.._etc_passwd", FileRules.safeName("../../etc/passwd", null))
        assertEquals("a_b_c_d.pdf", FileRules.safeName("a/b\\c:d.pdf", null))
        assertEquals("File.pdf", FileRules.safeName("", "application/pdf"))
        assertEquals("File", FileRules.safeName("  ", null))
        assertEquals("hidden", FileRules.safeName(".hidden", null))
        assertFalse(FileRules.safeName("x\u0000y\nz.pdf", null).contains("\n"))
    }

    @Test fun aPercentEncodedNameFromTheServerIsDecoded() {
        assertEquals("QA Test correspondence.pdf", FileRules.safeName("QA%20Test%20correspondence.pdf", "application/pdf"))
        assertEquals("Fattura n° 5714.pdf", FileRules.safeName("Fattura%20n%C2%B0%205714.pdf", "application/pdf"))
        // a decoded folder separator or control character is still made safe
        assertEquals("a_b_c.pdf", FileRules.safeName("a%2Fb%5Cc.pdf", null))
        assertFalse(FileRules.safeName("x%0Ay.pdf", null).contains("\n"))
        assertEquals("_.._etc_passwd", FileRules.safeName("..%2F..%2Fetc%2Fpasswd", null))
        // text that is not valid percent-encoding is kept as it came ("100% sure.pdf")
        assertEquals("100% sure.pdf", FileRules.safeName("100% sure.pdf", null))
        // a plus sign is a plus sign, not a space
        assertEquals("a+b.pdf", FileRules.safeName("a+b.pdf", null))
    }

    @Test fun aMissingExtensionIsFilledFromTheType() {
        assertEquals("attachment.pdf", FileRules.safeName("attachment", "application/pdf"))
        assertEquals("photo.jpg", FileRules.safeName("photo", "image/jpeg"))
        assertEquals("sheet.xlsx", FileRules.safeName("sheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
        assertEquals("blob", FileRules.safeName("blob", "application/x-unknown"))
    }

    @Test fun aLongNameIsCutButKeepsItsExtension() {
        val n = FileRules.safeName("a".repeat(300) + ".pdf", null)
        assertTrue(n.endsWith(".pdf"))
        assertTrue(n.length <= 130)
    }

    @Test fun theNameInAContentDispositionHeaderIsFound() {
        assertEquals("QA%20Test.pdf", FileRules.nameFromDisposition("attachment; filename=\"QA%20Test.pdf\""))
        assertEquals("a.pdf", FileRules.nameFromDisposition("attachment; filename=a.pdf"))
        assertEquals("a%20b.pdf", FileRules.nameFromDisposition("attachment; filename*=UTF-8''a%20b.pdf"))
        assertNull(FileRules.nameFromDisposition("inline"))
        assertNull(FileRules.nameFromDisposition(null))
    }
}

class StringsTest {
    @Test fun everyMessageExistsInBothLanguages() {
        for (m in Msg.values()) {
            assertFalse("$m has no English text", Strings.text(m, false).isEmpty())
            assertFalse("$m has no Italian text", Strings.text(m, true).isEmpty())
        }
    }

    @Test fun italianIsReallyTranslatedWhereTheWordsDiffer() {
        assertNotEquals(Strings.text(Msg.SIGN_OUT, false), Strings.text(Msg.SIGN_OUT, true))
        assertNotEquals(Strings.text(Msg.TRY_AGAIN, false), Strings.text(Msg.TRY_AGAIN, true))
        assertNotEquals(Strings.text(Msg.NO_CONNECTION, false), Strings.text(Msg.NO_CONNECTION, true))
    }

    @Test fun phoneLanguagePicksItalianOnlyWhenItIsTheFirstChoice() {
        assertTrue(Strings.isItalian(listOf("it-IT", "en-US")))
        assertTrue(Strings.isItalian(listOf("it")))
        assertFalse(Strings.isItalian(listOf("en-US", "it-IT")))
        assertFalse(Strings.isItalian(emptyList()))
    }
}
