import Foundation

/// Remembers when each opened file's local copy must be removed (the CRM says how long: 2 minutes for sensitive papers, 15 for the rest).
/// Kept on disk so a restart of the Finder extension does not forget a copy. PURE apart from the defaults store it is given.
public final class EvictionLedger: @unchecked Sendable {
    private let defaults: UserDefaults
    private let key: String
    private let lock = NSLock()
    /// Used when an older server does not say: the shorter, safer time.
    public static let fallbackKeepSeconds = 120

    public init(defaults: UserDefaults = .standard, key: String = "td-storage-eviction-ledger") {
        self.defaults = defaults; self.key = key
    }

    private func load() -> [String: Double] { (defaults.dictionary(forKey: key) as? [String: Double]) ?? [:] }
    private func save(_ d: [String: Double]) { defaults.set(d, forKey: key) }

    /// A file was just opened: its copy is due for removal `keepSeconds` from `now`. Opening it again later restarts the clock.
    public func record(id: String, keepSeconds: Int?, now: Date = Date()) {
        let keep = max(1, keepSeconds ?? Self.fallbackKeepSeconds)
        lock.lock(); defer { lock.unlock() }
        var d = load(); d[id] = now.timeIntervalSince1970 + Double(keep); save(d)
    }

    /// Everything whose time is up.
    public func due(now: Date = Date()) -> [String] {
        lock.lock(); defer { lock.unlock() }
        return load().filter { $0.value <= now.timeIntervalSince1970 }.map { $0.key }.sorted()
    }

    /// The copy is gone (or was never there): stop tracking it.
    public func remove(id: String) {
        lock.lock(); defer { lock.unlock() }
        var d = load(); d.removeValue(forKey: id); save(d)
    }

    public var pendingCount: Int { lock.lock(); defer { lock.unlock() }; return load().count }
}
