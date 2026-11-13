import Foundation

/// Learns, from the CRM, WHERE a person's storage is shown under a company (job 1992a087, 2026-11-13).
///
/// A person's storage shows in Finder twice: under People, and under every company the person belongs to (company › 2. Contacts › person).
/// The change feed names the plain item only, so a change must also be told to Finder under each company. Until now the Mac learned those
/// companies only when Finder opened a company's Contacts folder — a folder Finder had cached before the update was never re-listed, so a new file
/// stayed missing under the company for good (Luca, 2026-11-13). Now the CRM names the places, so nothing depends on Finder opening anything.
///
/// Generic: it knows nothing about people or companies. It asks about each storage at most once per `recheckSeconds`, and stores what the CRM
/// answers in the same persisted `ViaRegistry` the Finder listing already fills.
public final class RouteBook: @unchecked Sendable {
    public static let recheckSeconds: TimeInterval = 1800
    public static let questionSize = 40
    public static let shared = RouteBook(registry: .shared)

    private let registry: ViaRegistry
    private let lock = NSLock()
    private var checked: [String: Date] = [:]

    public init(registry: ViaRegistry) { self.registry = registry }

    /// The storages (no repeats, order kept) the CRM has not been asked about lately.
    public func needingCheck(_ owners: [String], now: Date = Date()) -> [String] {
        lock.lock(); defer { lock.unlock() }
        var seen = Set<String>()
        return owners.filter { o in
            guard seen.insert(o).inserted else { return false }
            if let t = checked[o], now.timeIntervalSince(t) < Self.recheckSeconds { return false }
            return true
        }
    }

    /// The CRM answered for `asked`: remember every place it named, and that these storages were asked (a storage that is nobody's person gets no places).
    public func apply(asked: [String], routes: [RouteEntry], now: Date = Date()) {
        for r in routes where asked.contains(r.owner) { registry.record(link: "\(r.company):\(r.folder):\(r.owner)", now: now) }
        lock.lock(); defer { lock.unlock() }
        for o in asked { checked[o] = now }
    }

    /// Questions of at most `questionSize` storages each.
    public static func questions(_ owners: [String]) -> [[String]] {
        stride(from: 0, to: owners.count, by: questionSize).map { Array(owners[$0..<min($0 + questionSize, owners.count)]) }
    }
}

/// PURE: the warning before a Mac must be approved again (the CRM caps a sign-in at 30 days) and the words when it has ended.
public enum SignInExpiry {
    public static let warnDays: Double = 5
    public static let endedMessage = "TD Storage signed this Mac out. The CRM asks for a new sign-in every 30 days (or when someone signs this Mac out). Sign in again to see your files in Finder."

    private static func parse(_ s: String?) -> Date? {
        guard let s else { return nil }
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }

    /// Whole days left, counted up (a few hours left = 1 day, less than that = 0); nil when the CRM did not say.
    public static func daysLeft(expiresAt: String?, now: Date) -> Int? {
        guard let end = parse(expiresAt) else { return nil }
        let seconds = end.timeIntervalSince(now)
        return seconds <= 0 ? 0 : Int((seconds / 86_400).rounded(.up))
    }

    /// The warning to show, or nil when there is nothing to warn about yet (more than `warnDays` left, or unknown).
    public static func warning(expiresAt: String?, now: Date, timeZone: TimeZone = .current) -> String? {
        guard let end = parse(expiresAt), let days = daysLeft(expiresAt: expiresAt, now: now), Double(days) <= warnDays else { return nil }
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = timeZone; f.dateFormat = "EEE d MMM"
        if end.timeIntervalSince(now) <= 0 { return "This Mac's sign-in has ended. Sign in again now, or Finder will stop showing your files." }
        let when = days <= 1 ? "today or tomorrow" : "in \(days) days"
        return "TD Storage will ask you to sign in again \(when) (by \(f.string(from: end))). Sign in again before then, so Finder keeps working."
    }
}
