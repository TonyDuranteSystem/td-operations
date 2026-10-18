import Foundation

/// Finder needs unique names inside a folder; the CRM does not guarantee it across storages (two companies can share a name, a person can
/// share a name with a company). Every name that appears more than once (ignoring case) gets a short, STABLE suffix from its id —
/// all of the duplicates, so a name never changes when a sibling appears or goes. Unique names are left exactly as they are.
public enum Disambiguator {
    public static func unique(_ entries: [(id: String, name: String)]) -> [String: String] {
        var count: [String: Int] = [:]
        for e in entries { count[e.name.lowercased(), default: 0] += 1 }
        var out: [String: String] = [:]
        var taken = Set<String>()
        for e in entries {
            var name = e.name
            if (count[e.name.lowercased()] ?? 0) > 1 { name = withSuffix(e.name, id: e.id, length: 4) }
            var len = 4
            while taken.contains(name.lowercased()) && len < 12 { len += 2; name = withSuffix(e.name, id: e.id, length: len) }   // two ids sharing a prefix
            taken.insert(name.lowercased())
            out[e.id] = name
        }
        return out
    }

    /// "Acme LLC" → "Acme LLC (3f9a)"; "Report.pdf" → "Report (3f9a).pdf" (the extension stays last so the file still opens).
    static func withSuffix(_ name: String, id: String, length: Int) -> String {
        let tag = String(id.replacingOccurrences(of: "-", with: "").prefix(length))
        let ns = name as NSString
        let ext = ns.pathExtension
        if !ext.isEmpty && ext.count <= 8 && !ext.contains(" ") { return ns.deletingPathExtension + " (\(tag))." + ext }
        return name + " (\(tag))"
    }
}
