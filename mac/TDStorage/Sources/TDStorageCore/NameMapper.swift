import Foundation

/// Finder file names. The CRM keeps names in Unicode NFC and may contain "/" (never in a Finder name). A Finder name with ":" is shown
/// by Finder as "/", so the two are swapped on the way in and out. A name is looked up by item id, never by this string.
public enum NameMapper {
    /// What the CRM calls it → what the Finder item is called.
    public static func finderName(fromServer name: String) -> String {
        name.precomposedStringWithCanonicalMapping.replacingOccurrences(of: "/", with: ":")
    }

    /// What Finder gives us → what the CRM stores (NFC, ":" back to "/", no control characters, trimmed).
    public static func serverName(fromFinder name: String) -> String {
        var s = name.precomposedStringWithCanonicalMapping.replacingOccurrences(of: ":", with: "/")
        s = String(s.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) })
        return s.trimmingCharacters(in: .whitespaces)
    }

    /// Finder allows 255 UTF-8 bytes per name.
    public static func fitsFinder(_ name: String) -> Bool { !name.isEmpty && name.utf8.count <= 255 }

    /// Names the app never uploads: system junk and the temporary names other apps use while saving or downloading. Matched by KNOWN patterns only
    /// (an exact name, a prefix, Apple's atomic-save marker ".sb-xxxxxxxx-xxxxxx", or a browser's partial-download ending) — never by a loose
    /// "contains", so a real file such as "Q3.sb-final.pdf" is kept. A real file that ends in one of the partial-download endings
    /// (.crdownload .download .part .partial .opdownload .tmp) is treated as temporary on purpose: that is what those endings mean.
    public static func isJunk(_ name: String) -> Bool {
        let n = name.lowercased()
        if n == ".ds_store" || n == "thumbs.db" || n == "desktop.ini" || n == "icon\r" { return true }
        if n.hasPrefix("._") || n.hasPrefix("~$") || n.hasPrefix(".~lock.") || n.hasPrefix("(a document being saved by") { return true }
        for ext in [".tmp", ".crdownload", ".part", ".partial", ".download", ".opdownload"] where n.hasSuffix(ext) { return true }
        // Apple's atomic-save temp name: "<name>.sb-<8 hex>-<6 letters or digits>"
        if n.range(of: #"\.sb-[0-9a-f]{8}-[0-9a-z]{6}$"#, options: .regularExpression) != nil { return true }
        return false
    }
}
