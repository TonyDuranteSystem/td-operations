import SwiftUI
import UserNotifications
import WebKit

struct NavItem: Decodable, Identifiable {
    let key: String
    let path: String
    let label: String
    let badge: Int
    var id: String { key }
}

struct Me: Decodable {
    let kind: String
    let items: [NavItem]
    let bar: [String]
    let menuBadge: Int
    let company: Company?
    struct Company: Decodable { let id: String; let name: String }
}

@MainActor
final class ClientModel: ObservableObject {
    static let shared = ClientModel()

    let serverURL = URL(string: (Bundle.main.object(forInfoDictionaryKey: "TDServerURL") as? String) ?? "") ?? URL(string: "https://td-operations-sandbox.vercel.app")!
    let apnsEnv = (Bundle.main.object(forInfoDictionaryKey: "TDApnsEnv") as? String) ?? "development"
    var web: WKWebView?
    var deviceToken: String?

    @Published var me: Me?
    @Published var showMenu = false
    @Published var currentPath = "/"
    @Published var alertStatus = "Alerts: not set up yet"

    /// Only a same-site path is ever opened from a link or an alert (never an address of another site, never protocol-relative).
    func open(path: String) {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), !path.contains("\\"), let url = URL(string: path, relativeTo: serverURL)?.absoluteURL else { return }
        web?.load(URLRequest(url: url))
        showMenu = false
    }

    func askForAlerts() async {
        let center = UNUserNotificationCenter.current()
        let granted = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) ?? false
        if granted { UIApplication.shared.registerForRemoteNotifications() } else { alertStatus = "Alerts: not allowed on this phone" }
    }

    /// Runs a request INSIDE the page, so it carries the signed-in session (the same cookies the portal itself uses). Returns the status and the text.
    private func pageRequest(method: String, path: String, body: String?) async -> (Int, String)? {
        guard let web else { return nil }
        let script = """
        const r = await fetch(path, { method, credentials: 'include', headers: { 'content-type': 'application/json' }, body: body });
        return JSON.stringify({ status: r.status, text: await r.text() });
        """
        do {
            let result = try await web.callAsyncJavaScript(script, arguments: ["path": path, "method": method, "body": body ?? NSNull()], in: nil, contentWorld: .page)
            guard let s = result as? String, let data = s.data(using: .utf8),
                  let o = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let status = o["status"] as? Int, let text = o["text"] as? String else { return nil }
            return (status, text)
        } catch { return nil }
    }

    /// Asks the server who this person is and what they can open (the bar and the Menu come from the answer). Not signed in = no bar.
    func refreshMe() async {
        guard let (status, text) = await pageRequest(method: "GET", path: "/api/portal/app/me", body: nil) else { return }
        if status == 200, let data = text.data(using: .utf8), let decoded = try? JSONDecoder().decode(Me.self, from: data) {
            me = decoded
            try? await UNUserNotificationCenter.current().setBadgeCount(decoded.menuBadge)
        } else {
            me = nil
        }
    }

    /// Saves this phone for alerts once there is both a token and a signed-in person.
    func registerDevice() async {
        guard let token = deviceToken else { return }
        guard me != nil else { alertStatus = "Alerts: waiting for sign-in"; return }
        let info = Bundle.main
        let body: [String: Any] = [
            "token": token, "bundleId": info.bundleIdentifier ?? "", "apnsEnv": apnsEnv, "deviceName": UIDevice.current.name,
            "appVersion": (info.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "", "appBuild": Int((info.object(forInfoDictionaryKey: "CFBundleVersion") as? String) ?? "") ?? 0,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: body), let json = String(data: data, encoding: .utf8) else { return }
        if let (status, text) = await pageRequest(method: "PUT", path: "/api/portal/app/devices", body: json) {
            alertStatus = status == 200 ? "Alerts: phone saved (\(apnsEnv))" : "Alerts: server said \(status) \(text.prefix(80))"
        } else {
            alertStatus = "Alerts: could not reach the server"
        }
    }
}
