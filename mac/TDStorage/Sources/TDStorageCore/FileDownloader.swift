import Foundation
import CryptoKit

/// Fetches one file: asks the CRM for a 60-second signed link, downloads it with a session that keeps nothing (no cache, no cookies), checks
/// the size and the SHA-256 against what the CRM recorded, and hands back a temporary file. A file that does not match is deleted and refused.
public final class FileDownloader: @unchecked Sendable {
    private let api: StorageAPI
    private let session: URLSession
    private let tempDirectory: URL

    public init(api: StorageAPI, session: URLSession? = nil, tempDirectory: URL = FileManager.default.temporaryDirectory) {
        self.api = api
        self.tempDirectory = tempDirectory
        if let session { self.session = session } else {
            let cfg = URLSessionConfiguration.ephemeral
            cfg.httpCookieStorage = nil; cfg.httpShouldSetCookies = false; cfg.urlCache = nil
            cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
            self.session = URLSession(configuration: cfg)
        }
    }

    public func download(fileId: String) async throws -> (file: URL, info: FileDownload) {
        let info = try await api.fileDownload(id: fileId)
        guard let url = URL(string: info.url), Self.linkAllowed(url) else { throw StorageAPIError.integrity("The download link is not valid.") }
        let (tmp, resp) = try await session.download(from: url, delegate: NoRedirects())
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            try? FileManager.default.removeItem(at: tmp)
            throw StorageAPIError.transport("The download did not start.")
        }
        let dest = tempDirectory.appendingPathComponent("tds-" + UUID().uuidString)
        do {
            try FileManager.default.moveItem(at: tmp, to: dest)
            let attrs = try FileManager.default.attributesOfItem(atPath: dest.path)
            if let want = info.size, let got = (attrs[.size] as? NSNumber)?.intValue, want != got { throw StorageAPIError.integrity("The file arrived with the wrong size.") }
            if let want = info.sha256 {
                let got = try Self.sha256(of: dest)
                if got.lowercased() != want.lowercased() { throw StorageAPIError.integrity("The file arrived damaged (checksum differs).") }
            }
            return (dest, info)
        } catch {
            try? FileManager.default.removeItem(at: dest)
            try? FileManager.default.removeItem(at: tmp)
            throw error
        }
    }

    /// https only; plain http to this Mac itself is allowed in a DEBUG (test-data) build only.
    static func linkAllowed(_ url: URL) -> Bool {
        if url.scheme == "https" { return true }
        #if DEBUG
        return url.scheme == "http" && (url.host == "localhost" || url.host == "127.0.0.1")
        #else
        return false
        #endif
    }

    /// Streams the file through SHA-256 (a 100 MB file never sits in memory).
    static func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            let chunk = try handle.read(upToCount: 1 << 20) ?? Data()
            if chunk.isEmpty { break }
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

/// A signed link never needs to redirect; if it does, something is wrong — never follow it (another host, or plain http).
private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
