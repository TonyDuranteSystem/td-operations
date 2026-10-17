import Foundation
import CryptoKit

/// Uploads one file's bytes to the signed address the CRM gave out (a single-use slot): a PUT straight to storage, from the file on disk
/// (never read whole into memory), with a session that keeps nothing. https only (plain http to this Mac itself in a DEBUG build).
public final class FileUploader: @unchecked Sendable {
    private let session: URLSession
    public init(session: URLSession? = nil) {
        if let session { self.session = session } else {
            let cfg = URLSessionConfiguration.ephemeral
            cfg.httpCookieStorage = nil; cfg.httpShouldSetCookies = false; cfg.urlCache = nil
            cfg.timeoutIntervalForResource = 600
            self.session = URLSession(configuration: cfg)
        }
    }

    public func upload(file: URL, to address: String, mimeType: String?) async throws {
        guard let url = URL(string: address), FileDownloader.linkAllowed(url) else { throw StorageAPIError.integrity("The upload address is not valid.") }
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue(mimeType ?? "application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.setValue("false", forHTTPHeaderField: "x-upsert")
        req.setValue("max-age=3600", forHTTPHeaderField: "cache-control")
        let (_, resp): (Data, URLResponse)
        do { (_, resp) = try await session.upload(for: req, fromFile: file, delegate: NoRedirectsUpload()) }
        catch { throw StorageAPIError.transport(error.localizedDescription) }
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw StorageAPIError.transport("The upload did not finish.") }
    }
}

private final class NoRedirectsUpload: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

/// The Mac's own stable id for ONE new file: the same parent, name, size and modification time always give the same id, so Finder
/// retrying a create after a lost answer reaches the same file in the CRM instead of making a second.
public enum ItemKey {
    public static func make(parent: String, name: String, size: Int, modified: Date?) -> String {
        let seed = "\(parent)|\(name)|\(size)|\(Int(modified?.timeIntervalSince1970 ?? 0))"
        var b = Array(SHA256.hash(data: Data(seed.utf8)).prefix(16))
        b[6] = (b[6] & 0x0f) | 0x50      // a name-based UUID (version 5 layout)
        b[8] = (b[8] & 0x3f) | 0x80
        let h = b.map { String(format: "%02x", $0) }.joined()
        let c = Array(h)
        func seg(_ a: Int, _ n: Int) -> String { String(c[a..<(a + n)]) }
        return "\(seg(0, 8))-\(seg(8, 4))-\(seg(12, 4))-\(seg(16, 4))-\(seg(20, 12))"
    }
}
