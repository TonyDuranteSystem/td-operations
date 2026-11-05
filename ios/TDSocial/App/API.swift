// Calls from the app to our own server. They use the SAME sign-in the web screens use (the cookies of the web view), and they hand any refreshed
// sign-in back to the web view: the server rotates the refresh token, so ignoring a refreshed cookie would sign the person out of the web screens.
import Foundation
import WebKit

private final class NoRedirect: NSObject, URLSessionTaskDelegate {
    // a redirect (to a login page) is an ANSWER here, not something to follow
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
enum API {
    private static let session = URLSession(configuration: .ephemeral, delegate: NoRedirect(), delegateQueue: nil)

    static func request(_ path: String, method: String = "GET", json: [String: Any]? = nil) async -> (status: Int, body: Data?) {
        guard let url = URL(string: AppConfig.serverURL.absoluteString + path) else { return (-1, nil) }
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = method
        req.httpShouldHandleCookies = false
        req.setValue("TDSocial/\(AppConfig.version) (native)", forHTTPHeaderField: "User-Agent")
        for (k, v) in HTTPCookie.requestHeaderFields(with: await serverCookies()) { req.setValue(v, forHTTPHeaderField: k) }
        if let json = json {
            req.httpBody = try? JSONSerialization.data(withJSONObject: json)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        do {
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse else { return (-1, nil) }
            await adoptRefreshedCookies(http, url: url)
            return (http.statusCode, data)
        } catch {
            return (-1, nil)
        }
    }

    static func serverCookies() async -> [HTTPCookie] {
        let host = AppConfig.serverHost
        let all = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
        return all.filter { c in
            let d = c.domain.hasPrefix(".") ? String(c.domain.dropFirst()) : c.domain
            return host == d || host.hasSuffix("." + d)
        }
    }

    private static func adoptRefreshedCookies(_ http: HTTPURLResponse, url: URL) async {
        var headers: [String: String] = [:]
        for (k, v) in http.allHeaderFields { if let k = k as? String, let v = v as? String { headers[k] = v } }
        let fresh = HTTPCookie.cookies(withResponseHeaderFields: headers, for: url)
        guard !fresh.isEmpty else { return }
        let store = WKWebsiteDataStore.default().httpCookieStore
        for c in fresh { await store.setCookie(c) }
    }

    #if DEBUG
    /// Simulator testing only: a file `dev-session.json` in the app's Documents folder ({cookies:[{name,value}]}) signs the web view in without typing.
    /// Compiled out of Sandbox and Production builds.
    static func installDevSessionIfPresent() async {
        struct DevSession: Decodable { struct C: Decodable { let name: String; let value: String }; let cookies: [C] }
        let file = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("dev-session.json")
        guard let data = try? Data(contentsOf: file), let s = try? JSONDecoder().decode(DevSession.self, from: data) else { return }
        let store = WKWebsiteDataStore.default().httpCookieStore
        for c in s.cookies {
            let props: [HTTPCookiePropertyKey: Any] = [.name: c.name, .value: c.value, .domain: AppConfig.serverHost, .path: "/", .secure: "TRUE"]
            if let cookie = HTTPCookie(properties: props) { await store.setCookie(cookie) }
        }
        try? FileManager.default.removeItem(at: file)
    }
    #endif
}
