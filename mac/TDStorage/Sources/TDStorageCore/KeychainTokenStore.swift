import Foundation
import Security

/// Tokens in the macOS Keychain: THIS device only (never synced, never in a backup), readable only while the Mac is unlocked,
/// shared between the app and its Finder extension through a Keychain access group (needs a signed build with that group).
public final class KeychainTokenStore: TokenStore {
    private let service: String
    private let accessGroup: String?

    public init(service: String, accessGroup: String?) { self.service = service; self.accessGroup = accessGroup }

    private func base() -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "tokens"]
        if let g = accessGroup { q[kSecAttrAccessGroup as String] = g }
        q[kSecUseDataProtectionKeychain as String] = true
        return q
    }

    public func load() -> TokenPair? {
        var q = base(); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(TokenPair.self, from: data)
    }

    public func save(_ tokens: TokenPair) {
        guard let data = try? JSONEncoder().encode(tokens) else { return }
        let attrs: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly, kSecAttrSynchronizable as String: false]
        if SecItemUpdate(base() as CFDictionary, attrs as CFDictionary) == errSecItemNotFound {
            var add = base(); add.merge(attrs) { _, new in new }
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    public func clear() { SecItemDelete(base() as CFDictionary) }
}
