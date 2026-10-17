import Foundation
import Security

/// The 24-hour lease (dev job 1992a087): the Mac may serve the storage only while it has been in contact with the CRM within the last 24 hours.
/// Every successful answer from the CRM (the Finder extension asks for changes every 30 seconds) starts the 24 hours again, so an online Mac
/// never notices it. A Mac that stayed OFFLINE for a day refuses to serve, and the host app then signs itself out and removes the TD Storage
/// folder (which removes what was downloaded). THE SERVER ENFORCES THE SAME 24 HOURS (a Mac unseen for a day gets 401 / "approve again"), so
/// this check is the Mac's own convenience and clean-up, not the only guard. The honest limit: files the system keeps on disk are protected
/// by FileVault, not by this.
public protocol LeaseStore: AnyObject {
    func lastContact() -> Date?
    func touch()
    func clear()
}

public enum Lease {
    public static let maxAge: TimeInterval = 24 * 3600

    /// PURE. No record at all counts as expired (fails closed; the host app makes the record at sign-in and when an older install is first
    /// opened). A record dated in the FUTURE (a clock that was wrong when it was written, or has been corrected since) is treated as "just now":
    /// it cannot lock the Mac out, and it cannot extend anything (the server counts the real time).
    public static func isExpired(last: Date?, now: Date = Date(), maxAge: TimeInterval = Lease.maxAge) -> Bool {
        guard let last else { return true }
        return max(0, now.timeIntervalSince(last)) > maxAge
    }
}

public extension LeaseStore {
    func isExpired(now: Date = Date()) -> Bool { Lease.isExpired(last: lastContact(), now: now) }
}

public final class MemoryLeaseStore: LeaseStore {
    private var date: Date?
    public init(_ date: Date? = nil) { self.date = date }
    public func lastContact() -> Date? { date }
    public func touch() { date = Date() }
    public func clear() { date = nil }
}

/// In the Keychain next to the tokens (this device only), so the host app and the Finder extension see the same time.
public final class KeychainLeaseStore: LeaseStore {
    private let service: String
    private let accessGroup: String?
    public init(service: String, accessGroup: String?) { self.service = service; self.accessGroup = accessGroup }

    private func base() -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "lease"]
        if let g = accessGroup { q[kSecAttrAccessGroup as String] = g }
        q[kSecUseDataProtectionKeychain as String] = true
        return q
    }

    public func lastContact() -> Date? {
        var q = base(); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }                    // really no record
        // any OTHER failure (the Keychain is locked, a momentary error) is NOT "no record": count it as fresh — the server enforces the lease anyway
        guard status == errSecSuccess, let data = out as? Data, let text = String(data: data, encoding: .utf8), let t = Double(text) else { return Date() }
        return Date(timeIntervalSince1970: t)
    }

    public func touch() {
        let data = Data(String(Date().timeIntervalSince1970).utf8)
        let attrs: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly, kSecAttrSynchronizable as String: false]
        if SecItemUpdate(base() as CFDictionary, attrs as CFDictionary) == errSecItemNotFound {
            var add = base(); add.merge(attrs) { _, new in new }
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    public func clear() { SecItemDelete(base() as CFDictionary) }
}
