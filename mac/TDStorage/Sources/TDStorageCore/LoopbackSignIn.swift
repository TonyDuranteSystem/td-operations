import Foundation
import Network

/// The browser leg of the sign-in (RFC 8252): listen on 127.0.0.1 on a random port, open the CRM approval page, wait for the redirect
/// http://127.0.0.1:<port>/cb?code=…&state=…, answer it with a small "you can close this page" page, and hand back the code.
/// Bound to the loopback interface ONLY; accepts exactly one valid callback; gives up after `timeout` seconds.
public final class LoopbackSignIn: @unchecked Sendable {
    public struct Started { public let redirectURI: String; public let approvalURL: URL; public let checkCode: String }
    public enum SignInError: Error { case timedOut, stateMismatch, noCode, listenFailed }

    private let queue = DispatchQueue(label: "td-storage.loopback")
    private var listener: NWListener?
    private var continuation: CheckedContinuation<String, Error>?
    private var expectedState = ""
    private var finished = false

    public init() {}

    /// Starts listening and returns what to show/open. Call `waitForCode` next.
    public func start(baseURL: URL, deviceName: String, challenge: String, state: String, checkCode: String) async throws -> Started {
        expectedState = state
        let params = NWParameters.tcp
        params.requiredInterfaceType = .loopback
        params.acceptLocalOnly = true
        let l = try NWListener(using: params, on: .any)
        listener = l
        l.newConnectionHandler = { [weak self] c in self?.handle(c) }
        let port: UInt16 = try await withCheckedThrowingContinuation { cont in
            let once = OnceFlag()
            l.stateUpdateHandler = { st in
                switch st {
                case .ready: if once.first() { cont.resume(returning: l.port?.rawValue ?? 0) }
                case .failed: if once.first() { cont.resume(throwing: SignInError.listenFailed) }
                default: break
                }
            }
            l.start(queue: self.queue)
        }
        guard port >= 1024 else { throw SignInError.listenFailed }
        let redirect = "http://127.0.0.1:\(port)/cb"
        var comps = URLComponents(url: baseURL.appendingPathComponent("storage-app/approve"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [
            URLQueryItem(name: "device_name", value: deviceName), URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "redirect_uri", value: redirect), URLQueryItem(name: "state", value: state),
        ]
        return Started(redirectURI: redirect, approvalURL: comps.url!, checkCode: checkCode)
    }

    public func waitForCode(timeout: TimeInterval = 300) async throws -> String {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<String, Error>) in
            queue.async {
                self.continuation = cont
                self.queue.asyncAfter(deadline: .now() + timeout) { self.finish(.failure(SignInError.timedOut)) }
            }
        }
    }

    private func finish(_ result: Result<String, Error>) {
        guard !finished else { return }
        finished = true
        listener?.cancel(); listener = nil
        continuation?.resume(with: result); continuation = nil
    }

    private func handle(_ conn: NWConnection) {
        conn.start(queue: queue)
        conn.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, _, _ in
            guard let self, let data, let text = String(data: data, encoding: .utf8) else { conn.cancel(); return }
            let first = text.split(separator: "\r\n", maxSplits: 1).first.map(String.init) ?? ""
            let parts = first.split(separator: " ")
            var ok = false
            if parts.count >= 2, parts[0] == "GET", let comps = URLComponents(string: "http://127.0.0.1" + parts[1]), comps.path == "/cb" {
                let q = Dictionary(uniqueKeysWithValues: (comps.queryItems ?? []).compactMap { i in i.value.map { (i.name, $0) } })
                if q["state"] == self.expectedState, let code = q["code"], !code.isEmpty { ok = true; self.reply(conn, ok: true); self.finish(.success(code)) }
                else if q["state"] != self.expectedState { self.reply(conn, ok: false); self.finish(.failure(SignInError.stateMismatch)) }
                else { self.reply(conn, ok: false); self.finish(.failure(SignInError.noCode)) }
            }
            if !ok && !self.finished { self.reply(conn, ok: false) }
        }
    }

    private func reply(_ conn: NWConnection, ok: Bool) {
        let body = ok ? "<html><body style='font-family:-apple-system;padding:40px'><h2>TD Storage is signed in</h2><p>You can close this page and go back to the app.</p></body></html>"
                      : "<html><body style='font-family:-apple-system;padding:40px'><h2>Sign-in did not complete</h2><p>Go back to the TD Storage app and try again.</p></body></html>"
        let head = "HTTP/1.1 \(ok ? "200 OK" : "400 Bad Request")\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n"
        conn.send(content: Data((head + body).utf8), completion: .contentProcessed { _ in conn.cancel() })
    }
}

/// True exactly once (a state handler can fire several times; a continuation may only be resumed once).
private final class OnceFlag: @unchecked Sendable {
    private let lock = NSLock(); private var done = false
    func first() -> Bool { lock.lock(); defer { lock.unlock() }; if done { return false }; done = true; return true }
}
