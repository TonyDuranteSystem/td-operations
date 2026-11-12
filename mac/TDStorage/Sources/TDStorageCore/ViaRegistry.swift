import Foundation

/// Remembers which "company › 2. Contacts › person" entries Finder has been shown (job 1992a087, 2026-11-12: Luca saw 3 files through the company
/// route and 4 through People). A person's storage shows in two places — People, and every company the person belongs to — and Finder needs ONE id per
/// place (`ItemID.via`). The change feed names the plain item only, so the copy under a company never heard about a new file until that folder was
/// reopened. With this list the change handler also updates the same item under every route Finder has seen for that storage.
///
/// Generic: it knows nothing about people or companies, only "this storage (target) was shown under this entry (link)". A route not seen for
/// `maxAgeDays` is forgotten (Finder cannot be showing it any more), and the list never grows past `maxLinks`. Kept on disk like the eviction ledger.
public final class ViaRegistry: @unchecked Sendable {
    private let defaults: UserDefaults
    private let key: String
    private let lock = NSLock()
    public static let maxLinks = 3000
    public static let maxAgeDays: Double = 90
    /// the one the Finder extension uses
    public static let shared = ViaRegistry()

    public init(defaults: UserDefaults = .standard, key: String = "td-storage-via-links") {
        self.defaults = defaults; self.key = key
    }

    private func load() -> [String: Double] { (defaults.dictionary(forKey: key) as? [String: Double]) ?? [:] }
    private func save(_ d: [String: Double]) { defaults.set(d, forKey: key) }

    /// `link` = "<companyOwnerId>:<contactsFolderId>:<targetStorageId>" (the text after "l:" in the person's entry id). Entries with no storage of their own
    /// ("c-…") show nothing and are not kept.
    public func record(link: String, now: Date = Date()) {
        guard Self.target(of: link).map({ !$0.hasPrefix("c-") }) == true else { return }
        lock.lock(); defer { lock.unlock() }
        var d = load()
        guard d[link] == nil || now.timeIntervalSince1970 - (d[link] ?? 0) > 3600 else { return }   // at most one disk write an hour per route
        d[link] = now.timeIntervalSince1970
        let cutoff = now.timeIntervalSince1970 - Self.maxAgeDays * 86_400
        d = d.filter { $0.value >= cutoff }
        if d.count > Self.maxLinks { for k in d.sorted(by: { $0.value < $1.value }).prefix(d.count - Self.maxLinks).map({ $0.key }) { d.removeValue(forKey: k) } }
        save(d)
    }

    /// Every route this storage has been shown under (empty = none, the plain places are all there is).
    public func links(for target: String, now: Date = Date()) -> [String] {
        lock.lock(); defer { lock.unlock() }
        let cutoff = now.timeIntervalSince1970 - Self.maxAgeDays * 86_400
        return load().filter { $0.value >= cutoff && Self.target(of: $0.key) == target }.map { $0.key }.sorted()
    }

    /// The storage a link points at: the last of its three parts.
    public static func target(of link: String) -> String? {
        let parts = link.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        return parts.count == 3 && parts.allSatisfy({ !$0.isEmpty }) ? String(parts[2]) : nil
    }

    public var count: Int { lock.lock(); defer { lock.unlock() }; return load().count }
}
