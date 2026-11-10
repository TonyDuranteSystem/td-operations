// What counts as a FILE (a PDF, a picture, an office document, a download). Pure, so it is unit-tested without a phone. Same rule as TD Social's app:
// a page that turns out to be a file opens in the phone's own viewer over the app, so it never replaces the screen and nothing is left without a way back.
import Foundation

public enum FileRules {
    /// Types that are PAGES of our own screens (or plain text): they stay in the web view.
    static let pageTypes: Set<String> = [
        "text/html", "application/xhtml+xml", "text/plain", "text/xml", "application/xml",
        "application/json", "text/javascript", "application/javascript", "text/css",
    ]

    /// Types that are files even though they do not start with "image/" or "application/vnd."
    static let fileTypes: Set<String> = [
        "application/pdf", "application/octet-stream", "application/zip", "application/msword", "application/rtf", "text/rtf", "text/csv",
        "application/x-zip-compressed", "application/vnd.ms-excel",
    ]

    /// Does a page the web view is about to show count as a file to open in the phone's own viewer? `contentDisposition` is the server's header.
    public static func opensAsFile(mimeType: String?, contentDisposition: String?) -> Bool {
        if let d = contentDisposition?.trimmingCharacters(in: .whitespaces).lowercased(), d.hasPrefix("attachment") { return true }
        guard let m = mimeOnly(mimeType) else { return false }
        if pageTypes.contains(m) { return false }
        if m.hasPrefix("image/") || m.hasPrefix("video/") || m.hasPrefix("audio/") { return true }
        return fileTypes.contains(m) || m.hasPrefix("application/vnd.")
    }

    static func mimeOnly(_ mime: String?) -> String? {
        guard let first = mime?.split(separator: ";").first else { return nil }
        let m = first.trimmingCharacters(in: .whitespaces).lowercased()
        return m.isEmpty ? nil : m
    }

    /// A safe file name for the phone's temporary folder: no folders, no control characters, a real extension (the viewer needs one to know the type).
    public static func safeName(_ suggested: String, mimeType: String?) -> String {
        // our server sends the name URL-encoded inside plain quotes (`filename="QA%20Test.pdf"`), so decode it first; the cleaning below then still applies
        // to the decoded text (a decoded "/" or control character becomes "_")
        let decoded = suggested.removingPercentEncoding ?? suggested
        var name = decoded.unicodeScalars.map { s -> String in
            if s == "/" || s == "\\" || s == ":" || CharacterSet.controlCharacters.contains(s) { return "_" }
            return String(s)
        }.joined().trimmingCharacters(in: .whitespacesAndNewlines)
        while name.hasPrefix(".") { name.removeFirst() }
        if name.isEmpty { name = "File" }
        if name.count > 120 {
            let ext = (name as NSString).pathExtension
            let stem = String((name as NSString).deletingPathExtension.prefix(100))
            name = ext.isEmpty ? stem : stem + "." + ext
        }
        if (name as NSString).pathExtension.isEmpty, let ext = fileExtension(forMime: mimeType) { name += "." + ext }
        return name
    }

    static func fileExtension(forMime mime: String?) -> String? {
        switch mimeOnly(mime) {
        case "application/pdf": return "pdf"
        case "image/jpeg", "image/jpg": return "jpg"
        case "image/png": return "png"
        case "image/gif": return "gif"
        case "image/heic": return "heic"
        case "image/webp": return "webp"
        case "application/msword": return "doc"
        case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": return "docx"
        case "application/vnd.ms-excel": return "xls"
        case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": return "xlsx"
        case "application/vnd.openxmlformats-officedocument.presentationml.presentation": return "pptx"
        case "text/csv": return "csv"
        case "application/zip", "application/x-zip-compressed": return "zip"
        default: return nil
        }
    }
}
