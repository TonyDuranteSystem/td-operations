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

enum ClientSheet: String, Identifiable {
    case menu, alerts
    var id: String { rawValue }
}

@MainActor
final class ClientModel: ObservableObject {
    static let shared = ClientModel()

    /// two small things kept on the phone (declared in PrivacyInfo.xcprivacy, reason CA92.1): whether the person was already asked about alerts, and the alert token
    private let askedKey = "td.client.alertsAsked"
    private let tokenKey = "td.client.alertToken"

    var web: WKWebView?
    var deviceToken: String?
    /// the page an alert asked for before the web view existed (the app was closed when the person tapped it)
    var pendingPath: String?
    private var registeredToken: String?
    private var askedForRemote = false

    @Published var me: Me?
    @Published var sheet: ClientSheet?
    @Published var currentPath = "/"
    /// the person (or iPhone Settings) said no to alerts
    @Published var alertsOff = false
    /// the page could not be loaded (no connection ...)
    @Published var loadFailed = false
    /// debug flavour only: what the alert registration did (shown in the Menu so a simulator test can read it)
    @Published var status = ""

    // MARK: pages

    /// Only a same-site path is ever opened from a link or an alert (never an address of another site, never protocol-relative).
    func open(path: String) {
        guard let safe = AlertRouting.safeRelativePath(path), let url = URL(string: safe, relativeTo: AppConfig.serverURL)?.absoluteURL else { return }
        sheet = nil
        guard let web else { pendingPath = safe; return }
        loadFailed = false
        web.load(URLRequest(url: url))
    }

    func retry() {
        loadFailed = false
        if let web, web.url != nil { web.reload() } else { web?.load(URLRequest(url: AppConfig.serverURL.appendingPathComponent("portal"))) }
    }

    // MARK: alerts

    /// Alerts are asked about once, in context, after the person has signed in (never at launch). Already allowed = just refresh the alert token.
    func checkAlerts() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .notDetermined:
            alertsOff = false
            if !UserDefaults.standard.bool(forKey: askedKey), sheet == nil { sheet = .alerts }
        case .authorized, .provisional, .ephemeral:
            alertsOff = false
            registerForRemoteOnce()
        case .denied:
            alertsOff = true
        @unknown default:
            break
        }
    }

    /// At launch: a phone that already allowed alerts asks Apple for its token again (it can change); nobody is asked anything here.
    func checkAlertsAtLaunch() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral: registerForRemoteOnce()
        default: break
        }
    }

    func turnOnAlerts() async {
        UserDefaults.standard.set(true, forKey: askedKey)
        sheet = nil
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])) ?? false
        if granted { alertsOff = false; registerForRemoteOnce() } else { alertsOff = true }
    }

    func notNow() {
        UserDefaults.standard.set(true, forKey: askedKey)
        sheet = nil
    }

    func openPhoneSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    }

    private func registerForRemoteOnce() {
        guard !askedForRemote else { return }
        askedForRemote = true
        UIApplication.shared.registerForRemoteNotifications()
    }

    func didGetToken(_ hex: String) async {
        deviceToken = hex
        await registerDevice()
    }

    // MARK: talking to the server (inside the page, so the request carries the signed-in session)

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
            await checkAlerts()
            await registerDevice()
        } else {
            me = nil
            registeredToken = nil
        }
    }

    /// Saves this phone for alerts once there is both a token and a signed-in person (once per token; again after a sign-out and a new sign-in).
    func registerDevice() async {
        guard let token = deviceToken, me != nil, registeredToken != token else { return }
        let body: [String: Any] = [
            "token": token, "bundleId": AppConfig.bundleId, "apnsEnv": AppConfig.apnsEnv, "deviceName": UIDevice.current.name,
            "appVersion": AppConfig.version, "appBuild": AppConfig.build,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: body), let json = String(data: data, encoding: .utf8) else { return }
        if let (status, text) = await pageRequest(method: "PUT", path: "/api/portal/app/devices", body: json) {
            if status == 200 { registeredToken = token; UserDefaults.standard.set(token, forKey: tokenKey) }
            note(status == 200 ? "Alerts: phone saved (\(AppConfig.apnsEnv))" : "Alerts: server said \(status) \(text.prefix(80))")
        } else {
            note("Alerts: could not reach the server")
        }
    }

    private func note(_ s: String) {
        #if DEBUG
        status = s
        #endif
    }

    // MARK: sign out

    /// Removes this phone from the server (so a different person on this phone never gets this person's alerts), ends the sign-in on this phone and
    /// shows the portal's sign-in page. The portal has no sign-out button in the app (its side menu is hidden), so this is the app's own.
    func signOut() async {
        if let token = deviceToken ?? UserDefaults.standard.string(forKey: tokenKey) {
            let body = try? JSONSerialization.data(withJSONObject: ["token": token, "bundleId": AppConfig.bundleId])
            _ = await pageRequest(method: "DELETE", path: "/api/portal/app/devices", body: body.flatMap { String(data: $0, encoding: .utf8) })
        }
        UserDefaults.standard.removeObject(forKey: tokenKey)
        registeredToken = nil
        me = nil
        sheet = nil
        try? await UNUserNotificationCenter.current().setBadgeCount(0)
        let store = WKWebsiteDataStore.default()
        await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        loadFailed = false
        web?.load(URLRequest(url: AppConfig.serverURL.appendingPathComponent("portal")))
    }
}
