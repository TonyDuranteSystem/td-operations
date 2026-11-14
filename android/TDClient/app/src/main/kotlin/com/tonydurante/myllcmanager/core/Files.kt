// File names for the files the portal hands to the app (a PDF, a picture, an office document). Pure, so it is unit-tested without a phone.
// Port of the name rules in ios/TDClient/Sources/TDClientCore/Files.swift (on Android the web view itself says "this is a download", so the iPhone's
// "does this page count as a file" rule is not needed).
package com.tonydurante.myllcmanager.core

import org.json.JSONObject
import java.io.InputStream
import java.net.URLDecoder
import java.util.Base64

/** A file the page handed to the app, decoded. */
class DecodedFile(val name: String, val type: String?, val bytes: ByteArray)

object FileRules {
    /** the biggest file the app takes from a page or the server (a larger one is refused with the "couldn't open" message) */
    const val MAX_FILE_BYTES = 40L * 1024 * 1024

    /** the longest file name (in UTF-8 bytes) the app writes: the phone's file system refuses 255, and a name of 90 emoji is already longer */
    private const val MAX_NAME_BYTES = 200

    /** the page's message for a file is base64 text (4 characters for 3 bytes) inside a little JSON: anything longer than this cannot be a file we accept */
    const val MAX_MESSAGE_CHARS = MAX_FILE_BYTES * 4 / 3 + 4096

    /** Cuts a text to at most `maxChars` characters and `maxBytes` UTF-8 bytes, never in the middle of a character (an emoji is two chars). */
    private fun cut(s: String, maxChars: Int, maxBytes: Int): String {
        val sb = StringBuilder()
        var bytes = 0
        var i = 0
        while (i < s.length) {
            val cp = s.codePointAt(i)
            val len = Character.charCount(cp)
            val b = String(Character.toChars(cp)).toByteArray(Charsets.UTF_8).size
            if (sb.length + len > maxChars || bytes + b > maxBytes) break
            sb.appendCodePoint(cp)
            bytes += b
            i += len
        }
        return sb.toString()
    }

    private fun utf8Size(s: String) = s.toByteArray(Charsets.UTF_8).size

    /** Reads a stream but gives up (null) as soon as it holds more than `max` bytes, so a file of unknown size cannot fill the phone's memory. */
    fun readUpTo(input: InputStream, max: Long): ByteArray? {
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        var total = 0L
        while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            total += n
            if (total > max) return null
            out.write(buffer, 0, n)
        }
        return out.toByteArray()
    }

    /**
     * Decodes the file the page handed over (`{name, type, data}` with the bytes in base64). Null when it is not a usable file: not readable, too big
     * (checked BEFORE the bytes are made) or empty (a failed read in the page must not open an empty file).
     */
    fun decodeMessage(json: String): DecodedFile? = try {
        val o = JSONObject(json)
        val data = o.getString("data")
        if (data.length.toLong() * 3 / 4 > MAX_FILE_BYTES) null
        else {
            val bytes = Base64.getMimeDecoder().decode(data)
            if (bytes.isEmpty()) null else DecodedFile(o.optString("name"), o.optString("type").ifEmpty { null }, bytes)
        }
    } catch (e: Exception) {
        null
    }

    private fun mimeOnly(mime: String?): String? {
        val first = mime?.split(';')?.firstOrNull() ?: return null
        val m = first.trim().lowercase()
        return m.ifEmpty { null }
    }

    private fun extensionOf(name: String): String {
        val i = name.lastIndexOf('.')
        return if (i > 0 && i < name.length - 1) name.substring(i + 1) else ""
    }

    /** A safe file name for the phone's temporary folder: no folders, no control characters, a real extension (the viewer needs one to know the type). */
    fun safeName(suggested: String, mimeType: String?): String {
        // our server sends the name URL-encoded inside plain quotes (`filename="QA%20Test.pdf"`), so decode it first; the cleaning below then still applies
        // to the decoded text (a decoded "/" or control character becomes "_"). Text that is not valid percent-encoding is kept as it came ("100% sure.pdf").
        val decoded = try {
            URLDecoder.decode(suggested.replace("+", "%2B"), "UTF-8")
        } catch (e: IllegalArgumentException) {
            suggested
        }
        var name = decoded.map { c -> if (c == '/' || c == '\\' || c == ':' || c.isISOControl()) '_' else c }.joinToString("").trim()
        while (name.startsWith(".")) name = name.removePrefix(".")
        if (name.isEmpty()) name = "File"
        if (name.length > 120 || utf8Size(name) > MAX_NAME_BYTES) {
            val ext = extensionOf(name)
            // a "extension" that is itself long (one dot far from the end) is not an extension
            val extPart = if (ext.isEmpty() || utf8Size(ext) > 20) "" else ".$ext"
            val stemFull = if (extPart.isEmpty()) name else name.removeSuffix(extPart)
            val stem = cut(stemFull, 100, MAX_NAME_BYTES - utf8Size(extPart)).ifEmpty { "File" }
            name = stem + extPart
        }
        if (extensionOf(name).isEmpty()) fileExtension(mimeType)?.let { name += ".$it" }
        return name
    }

    fun fileExtension(mime: String?): String? = when (mimeOnly(mime)) {
        "application/pdf" -> "pdf"
        "image/jpeg", "image/jpg" -> "jpg"
        "image/png" -> "png"
        "image/gif" -> "gif"
        "image/heic" -> "heic"
        "image/webp" -> "webp"
        "application/msword" -> "doc"
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" -> "docx"
        "application/vnd.ms-excel" -> "xls"
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" -> "xlsx"
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" -> "pptx"
        "text/csv" -> "csv"
        "application/zip", "application/x-zip-compressed" -> "zip"
        else -> null
    }

    /** The file name the server suggested in a `Content-Disposition` header (`filename="a.pdf"` or `filename*=UTF-8''a.pdf`), or null. */
    fun nameFromDisposition(contentDisposition: String?): String? {
        val d = contentDisposition ?: return null
        val m = Regex("""filename\*?=(?:UTF-8'')?"?([^";]+)"?""", RegexOption.IGNORE_CASE).find(d) ?: return null
        return m.groupValues[1].trim().ifEmpty { null }
    }
}
