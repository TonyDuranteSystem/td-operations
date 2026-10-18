import Foundation

public enum StorageAPIError: Error, Equatable {
    case notSignedIn                     // no tokens, or the CRM refused them and renewal failed
    case deviceRevoked                   // this Mac was signed out: wipe the local cache
    case notFound
    case forbidden(String)
    case openInCRM(String)               // a sensitive document: never downloaded to a Mac (the server decides)
    case rateLimited(String)             // this Mac downloaded / uploaded too much in the last hour
    case refused(String)                 // the CRM said no to a SAVE, in plain words (name taken, wrong folder, too big …) — final, not retried
    case leaseExpired                    // no successful contact with the CRM for 24 hours: the Mac must sign in again
    case integrity(String)               // what arrived is not what the CRM stored
    case server(Int, String)
    case transport(String)
    case badResponse
}

/// Where the tokens live. The app uses the Keychain (shared by the app and its Finder extension); tests use memory.
public protocol TokenStore: AnyObject {
    func load() -> TokenPair?
    func save(_ tokens: TokenPair)
    func clear()
}

public final class MemoryTokenStore: TokenStore {
    private var tokens: TokenPair?
    public init(_ tokens: TokenPair? = nil) { self.tokens = tokens }
    public func load() -> TokenPair? { tokens }
    public func save(_ tokens: TokenPair) { self.tokens = tokens }
    public func clear() { tokens = nil }
}

/// The CRM's /api/storage-app routes. Every call carries the bearer access token; a 401 triggers ONE renewal (shared by all calls that
/// fail at the same moment) and one retry. Ephemeral URLSession: no cookies, no cache — nothing about the storage is kept by the system.
public final class StorageAPI: @unchecked Sendable {
    public let baseURL: URL
    private let store: TokenStore
    private let session: URLSession
    private let refreshLock = NSLock()
    private var refreshTask: Task<TokenPair, Error>?

    private let lease: LeaseStore?

    public init(baseURL: URL, store: TokenStore, session: URLSession? = nil, lease: LeaseStore? = nil) {
        self.baseURL = baseURL
        self.store = store
        self.lease = lease
        if let session { self.session = session } else {
            let cfg = URLSessionConfiguration.ephemeral
            cfg.httpCookieStorage = nil
            cfg.httpShouldSetCookies = false
            cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
            cfg.urlCache = nil
            self.session = URLSession(configuration: cfg)
        }
    }

    // MARK: token swap (public routes)

    public func exchange(code: String, verifier: String, redirectURI: String) async throws -> TokenPair {
        let body: [String: String] = ["grant_type": "authorization_code", "code": code, "code_verifier": verifier, "redirect_uri": redirectURI]
        let tokens: TokenPair = try await post("api/storage-app/token", json: body)
        store.save(tokens)
        return tokens
    }

    private func renew() async throws -> TokenPair {
        // one renewal at a time: the app and its extension's parallel requests share it
        let task: Task<TokenPair, Error> = refreshLock.withLock {
            if let t = refreshTask { return t }
            let t = Task { [self] () throws -> TokenPair in
                guard let current = store.load() else { throw StorageAPIError.notSignedIn }
                do {
                    let fresh: TokenPair = try await post("api/storage-app/token", json: ["grant_type": "refresh_token", "refresh_token": current.refreshToken])
                    store.save(fresh)
                    return fresh
                } catch StorageAPIError.deviceRevoked {
                    store.clear(); throw StorageAPIError.deviceRevoked
                } catch StorageAPIError.forbidden {
                    store.clear(); throw StorageAPIError.notSignedIn
                } catch StorageAPIError.server(let code, _) where code == 400 {
                    store.clear(); throw StorageAPIError.notSignedIn     // expired / unknown / older than 30 days: approve again
                }
            }
            refreshTask = t
            return t
        }
        defer { refreshLock.withLock { refreshTask = nil } }
        return try await task.value
    }

    // MARK: data routes (token only)

    public func whoami() async throws -> WhoAmI { try await get("api/storage-app/whoami") }
    public func navigation() async throws -> [NavGroup] { (try await get("api/storage-app/navigation") as NavigationResponse).groups }
    public func folder(owner: String, folder: String? = nil) async throws -> FolderListing {
        var q = [URLQueryItem(name: "owner", value: owner)]
        if let folder { q.append(URLQueryItem(name: "folder", value: folder)) }
        return try await get("api/storage-app/folder", query: q)
    }
    /// A 60-second link for one file. Every file opens (since 2026-10-17 passports, IDs and ITIN papers too); the server only refuses a Mac over its hourly limit (429). A 403 open_in_crm is still understood in case it is ever switched back on.
    public func fileDownload(id: String) async throws -> FileDownload {
        try await get("api/storage-app/file", query: [URLQueryItem(name: "id", value: id)])
    }
    /// Saving a NEW file (phase P3 step A): 1) ask for a slot, 2) upload the bytes to the signed address, 3) save. `itemKey` is the Mac's stable id
    /// for this one file, so a retry after a lost answer returns the same file and never makes a second.
    public func uploadSlot(ownerId: String, folderId: String, name: String, size: Int, mimeType: String?, itemKey: String, replaceFileId: String? = nil) async throws -> UploadSlot {
        var body: [String: Any] = ["ownerId": ownerId, "folderId": folderId, "name": name, "size": size, "itemKey": itemKey]
        if let mimeType { body["mimeType"] = mimeType }
        if let replaceFileId { body["replaceFileId"] = replaceFileId }      // update a file THIS Mac saved (a new version of it)
        return try await postAuthorized("api/storage-app/upload-slot", body)
    }
    public func save(intentId: String, itemKey: String, replaceFileId: String? = nil) async throws -> SavedFile {
        var body: [String: Any] = ["intentId": intentId, "itemKey": itemKey]
        if let replaceFileId { body["replaceFileId"] = replaceFileId }
        return try await postAuthorized("api/storage-app/save", body)
    }
    public func item(kind: String, id: String) async throws -> ItemInfo {
        try await get("api/storage-app/item", query: [URLQueryItem(name: "kind", value: kind), URLQueryItem(name: "id", value: id)])
    }
    /// Take the head BEFORE walking the whole tree; changes made during the walk then arrive from it.
    public func head() async throws -> String? { (try await get("api/storage-app/changes", query: [URLQueryItem(name: "head", value: "1")]) as HeadResponse).cursor }
    public func changes(since cursor: String?, limit: Int = 500) async throws -> ChangesPage {
        var q = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { q.append(URLQueryItem(name: "since", value: cursor)) }
        return try await get("api/storage-app/changes", query: q)
    }

    // MARK: plumbing

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        try await authorized { token in
            var comps = URLComponents(url: self.baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
            if !query.isEmpty { comps.queryItems = query }
            var req = URLRequest(url: comps.url!)
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            return req
        }
    }

    private func postAuthorized<T: Decodable>(_ path: String, _ body: [String: Any]) async throws -> T {
        let data = try JSONSerialization.data(withJSONObject: body)
        return try await authorized { token in
            var req = URLRequest(url: self.baseURL.appendingPathComponent(path))
            req.httpMethod = "POST"
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = data
            return req
        }
    }

    private func authorized<T: Decodable>(_ make: (String) -> URLRequest) async throws -> T {
        // the 24-hour lease: a Mac that has not reached the CRM for a day refuses to serve anything (and the app signs itself out)
        if let lease, lease.isExpired() { throw StorageAPIError.leaseExpired }
        guard var tokens = store.load() else { throw StorageAPIError.notSignedIn }
        do { return try await send(make(tokens.accessToken)) }
        catch StorageAPIError.notSignedIn {
            tokens = try await renew()
            return try await send(make(tokens.accessToken))
        }
    }

    private func post<T: Decodable>(_ path: String, json: [String: String]) async throws -> T {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: json)
        return try await send(req)
    }

    private func send<T: Decodable>(_ req: URLRequest) async throws -> T {
        let data: Data, resp: URLResponse
        do { (data, resp) = try await session.data(for: req) } catch { throw StorageAPIError.transport(error.localizedDescription) }
        guard let http = resp as? HTTPURLResponse else { throw StorageAPIError.badResponse }
        switch http.statusCode {
        case 200..<300:
            // only a REAL answer from the CRM restarts the lease (a captive-portal page that says 200 does not decode, so it does not count)
            do { let value = try JSONDecoder().decode(T.self, from: data); lease?.touch(); return value } catch { throw StorageAPIError.badResponse }
        case 401: throw StorageAPIError.notSignedIn
        case 429:
            let body = try? JSONDecoder().decode(APIErrorBody.self, from: data)
            throw StorageAPIError.rateLimited(body?.message ?? body?.errorDescription ?? "Too many downloads or uploads. Try again later.")
        case 409, 413, 422:
            let body = try? JSONDecoder().decode(APIErrorBody.self, from: data)
            throw StorageAPIError.refused(body?.message ?? body?.errorDescription ?? body?.error ?? "This file could not be saved here.")
        case 403:
            let body = try? JSONDecoder().decode(APIErrorBody.self, from: data)
            if body?.error == "device_revoked" { throw StorageAPIError.deviceRevoked }
            if body?.error == "open_in_crm" { throw StorageAPIError.openInCRM(body?.message ?? "This document is not downloaded to a Mac. Open it in the CRM.") }
            throw StorageAPIError.forbidden(body?.errorDescription ?? body?.error ?? "Not allowed.")
        case 404: throw StorageAPIError.notFound
        default:
            let body = try? JSONDecoder().decode(APIErrorBody.self, from: data)
            throw StorageAPIError.server(http.statusCode, body?.errorDescription ?? body?.error ?? "Server error")
        }
    }
}
