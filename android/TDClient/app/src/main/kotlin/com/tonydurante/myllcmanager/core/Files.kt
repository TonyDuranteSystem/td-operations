// File names for the files the portal hands to the app (a PDF, a picture, an office document). Pure, so it is unit-tested without a phone.
// Port of the name rules in ios/TDClient/Sources/TDClientCore/Files.swift (on Android the web view itself says "this is a download", so the iPhone's
// "does this page count as a file" rule is not needed).
package com.tonydurante.myllcmanager.core

import java.net.URLDecoder

object FileRules {
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
        if (name.length > 120) {
            val ext = extensionOf(name)
            val stem = (if (ext.isEmpty()) name else name.removeSuffix(".$ext")).take(100)
            name = if (ext.isEmpty()) stem else "$stem.$ext"
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
