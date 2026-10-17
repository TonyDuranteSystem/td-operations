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

    /// Names the app never uploads (system junk, partial downloads, Office lock/temp files). Used from phase P3 on.
    public static func isJunk(_ name: String) -> Bool {
        let n = name.lowercased()
        if n == ".ds_store" || n == "thumbs.db" || n == "desktop.ini" || n == "icon\r" { return true }
        if n.hasPrefix("._") || n.hasPrefix("~$") || n.hasPrefix(".~lock.") { return true }
        for ext in [".tmp", ".crdownload", ".part", ".download", ".partial"] where n.hasSuffix(ext) { return true }
        if n.contains(".sb-") { return true }                      // Apple's atomic-save temp names
        return false
    }
}
