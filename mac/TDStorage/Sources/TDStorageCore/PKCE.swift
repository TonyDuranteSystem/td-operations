import Foundation
import CryptoKit

/// OAuth 2.0 PKCE (RFC 7636), S256 only. The verifier never leaves the app until the code is swapped for tokens.
public enum PKCE {
    /// 48 random bytes → a 64-character base64url verifier (RFC: 43–128 characters).
    public static func makeVerifier() -> String {
        var bytes = [UInt8](repeating: 0, count: 48)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        precondition(status == errSecSuccess, "no secure random bytes")
        return Data(bytes).base64URLEncoded
    }

    /// base64url(sha256(verifier)) — exactly what the server's `pkceS256` computes.
    public static func challenge(for verifier: String) -> String {
        Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncoded
    }

    /// The short code the app shows and the CRM approval page shows for the same challenge (so the person approving can compare them).
    /// MUST stay identical to `checkCode` in lib/storage-app/tokens.ts: sha256("td-storage-check:" + challenge), 8 characters of
    /// the alphabet below taken from the first 8 digest bytes, shown as ABCD-EFGH.
    public static func checkCode(for challenge: String) -> String {
        let digest = Array(SHA256.hash(data: Data(("td-storage-check:" + challenge).utf8)))
        let alphabet = Array("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
        let chars = (0..<8).map { alphabet[Int(digest[$0]) % alphabet.count] }
        return String(chars[0..<4]) + "-" + String(chars[4..<8])
    }

    /// A random `state` value to tie the browser round-trip to this attempt.
    public static func makeState() -> String {
        var bytes = [UInt8](repeating: 0, count: 24)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64URLEncoded
    }
}

extension Data {
    var base64URLEncoded: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
