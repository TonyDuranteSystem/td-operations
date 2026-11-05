// What counts as a FILE (a PDF, a picture, an office document, a download) and when the app shows its own Back bar. Pure, so it is unit-tested
// without a phone. Why it exists: an email attachment used to replace the whole page with a bare PDF and nothing on screen led back (5 Nov 2026).
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
        var name = suggested.unicodeScalars.map { s -> String in
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

public enum BackRules {
    /// The address prefixes of each tab's OWN screens. They have their own back arrow (or none), so the app's Back bar stays away from them.
    public static func ownScreens(for tabId: String) -> [String] {
        switch tabId {
        case "talk": return ["/talk"]
        case "portal": return ["/portal-chats"]
        case "whatsapp", "inbox": return ["/inbox"]
        case "marketing": return ["/marketing"]
        default: return []
        }
    }

    /// Show the app's Back bar when the tab has moved to some OTHER page (a client's page, an account, a form) and the web view can go back.
    public static func showBack(tabId: String, path: String?, canGoBack: Bool) -> Bool {
        guard canGoBack, let p = path?.lowercased() else { return false }
        let own = ownScreens(for: tabId)
        if own.isEmpty { return true }
        return !own.contains { p == $0 || p.hasPrefix($0 + "/") }
    }
}
