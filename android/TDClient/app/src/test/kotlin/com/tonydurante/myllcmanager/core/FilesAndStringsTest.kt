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

    // bug hunt 14 Nov, finding 5: the phone's file system refuses a name over 255 BYTES, and 85 emoji or Chinese characters are already more than that
    @Test fun aLongNameOfWideCharactersIsCutByBytesNotCharacters() {
        for (wide in listOf("日".repeat(90), "😀".repeat(90), "è".repeat(200))) {
            val n = FileRules.safeName("$wide.pdf", null)
            assertTrue("$n is ${n.toByteArray().size} bytes", n.toByteArray(Charsets.UTF_8).size <= 210)
            assertTrue(n.endsWith(".pdf"))
            // never cut in the middle of an emoji: every first half is followed by its second half and every second half is preceded by its first
            for (i in n.indices) {
                if (Character.isHighSurrogate(n[i])) assertTrue(i + 1 < n.length && Character.isLowSurrogate(n[i + 1]))
                if (Character.isLowSurrogate(n[i])) assertTrue(i > 0 && Character.isHighSurrogate(n[i - 1]))
            }
        }
        val emoji = FileRules.safeName("😀".repeat(90) + ".pdf", null)
        assertEquals(emoji, String(emoji.toByteArray(Charsets.UTF_8), Charsets.UTF_8)) // survives a round trip: no half characters
        // a very long "extension" is not kept as one
        val odd = FileRules.safeName("a." + "b".repeat(300), null)
        assertTrue(odd.toByteArray().size <= 200)
        // a short ordinary name is untouched
        assertEquals("Invoice 5714.pdf", FileRules.safeName("Invoice 5714.pdf", "application/pdf"))
    }

    // finding 5 and 7: what the page hands over is checked before anything is made, and an empty or broken file is never opened
    @Test fun aFileFromThePageIsDecodedOrRefused() {
        val ok = FileRules.decodeMessage("""{"name":"a.pdf","type":"application/pdf","data":"SGVsbG8="}""")!!
        assertEquals("a.pdf", ok.name)
        assertEquals("application/pdf", ok.type)
        assertEquals("Hello", String(ok.bytes))
        // line breaks inside the base64 text are fine
        assertEquals("Hello", String(FileRules.decodeMessage("""{"name":"a","data":"SGVs\nbG8="}""")!!.bytes))
        assertNull(FileRules.decodeMessage("""{"name":"a.pdf","type":"application/pdf","data":""}""")) // a failed read in the page
        assertNull(FileRules.decodeMessage("""{"name":"a.pdf","data":"!!!not base64!!!"}"""))
        assertNull(FileRules.decodeMessage("""{"name":"a.pdf"}"""))
        assertNull(FileRules.decodeMessage("not json"))
        // too big: refused from the length of the text, before any bytes are made
        val big = "A".repeat(((FileRules.MAX_FILE_BYTES + 1024) * 4 / 3).toInt())
        assertNull(FileRules.decodeMessage("""{"name":"a.pdf","data":"$big"}"""))
        assertTrue(FileRules.MAX_MESSAGE_CHARS > FileRules.MAX_FILE_BYTES)
    }

    @Test fun aFileOfUnknownSizeIsReadOnlyUpToTheLimit() {
        val small = ByteArray(1000) { it.toByte() }
        assertEquals(1000, FileRules.readUpTo(small.inputStream(), 5000)!!.size)
        assertEquals(1000, FileRules.readUpTo(small.inputStream(), 1000)!!.size) // exactly the limit is allowed
        assertNull(FileRules.readUpTo(small.inputStream(), 999))
        assertEquals(0, FileRules.readUpTo(ByteArray(0).inputStream(), 10)!!.size)
        // a long stream stops as soon as the limit is passed, without reading the rest
        var read = 0L
        val endless = object : java.io.InputStream() {
            override fun read(): Int = 1
            override fun read(b: ByteArray, off: Int, len: Int): Int { read += len; return len }
        }
        assertNull(FileRules.readUpTo(endless, 100_000))
        assertTrue(read < 200_000)
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
