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
    /// the company the page on screen shows (the page tells the app; see SelectionRules): the bar and the Menu list describe THAT company
    private(set) var selection = ""
    /// the address a page failed to load (so "Try again" opens THAT page, not the one before it)
    var failedURL: URL?
    /// a sign-out is in progress: nothing may ask the server or save the phone meanwhile
    private var signingOut = false
    /// bumped at every sign-out, so an answer that was already on its way for the person who left is thrown away
    private var meEpoch = 0
    /// the portal's sign-in page was shown since the phone was last saved (a person can sign in as someone else there without signing out first)
    private var sawLoginPage = false
    private var lastRegisterFailure: Date?

    @Published var me: Me?
    @Published var sheet: ClientSheet?
    @Published var currentPath = "/"
    /// the `tab` of the page on screen (TD Billing is the invoices page with `?tab=billing`)
    @Published var currentTab: String?
    /// what the server last said to "who am I": nil = not asked yet
    @Published var meOutcome: MeOutcome?
    /// "Not now" was chosen and iPhone has never been asked: the Menu offers to ask again
    @Published var alertsPending = false
    /// a brand-new web view is made at every sign-out, so no page of the person who left stays in its history (back swipe)
    @Published var webEpoch = 0
    /// the server could not be told to forget this phone (no connection ...): the person is NOT signed out yet
    @Published var signOutFailed = false
    /// the person (or iPhone Settings) said no to alerts
    @Published var alertsOff = false
    /// the page could not be loaded (no connection ...)
    @Published var loadFailed = false
    /// debug flavour only: what the alert registration did (shown in the Menu so a simulator test can read it)
    @Published var status = ""

    // MARK: pages

    /// An alert arrived while the app is open (AppDelegate.willPresent): the bar's numbers are asked again now and once more a few seconds later (`AlertRefreshRules`).
    func alertArrivedWhileOpen() {
        for delay in AlertRefreshRules.delays {
            Task { @MainActor in
                if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
                await self.refreshMe()
            }
        }
    }

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
        if let url = failedURL { failedURL = nil; web?.load(URLRequest(url: url)); return }
        if let web, web.url != nil { web.reload() } else { web?.load(URLRequest(url: AppConfig.serverURL.appendingPathComponent("portal"))) }
    }

    // MARK: alerts

    /// Alerts are asked about once, in context, after the person has signed in (never at launch). Already allowed = just refresh the alert token.
    func checkAlerts() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .notDetermined:
            alertsOff = false
            if UserDefaults.standard.bool(forKey: askedKey) {
                alertsPending = true      // "Not now" was chosen earlier: the Menu offers to ask again
            } else if sheet == nil {
                alertsPending = false
                sheet = .alerts
            }
        case .authorized, .provisional, .ephemeral:
            alertsOff = false
            alertsPending = false
            registerForRemoteOnce()
        case .denied:
            alertsPending = false
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
        alertsPending = false
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])) ?? false
        if granted { alertsOff = false; registerForRemoteOnce() } else { alertsOff = true }
    }

    func notNow() {
        UserDefaults.standard.set(true, forKey: askedKey)
        sheet = nil
        alertsPending = true
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
        // only while the page on screen IS our server (on a card page or another site the question would go to the wrong place)
        guard let web, PageRules.mayRunRequest(pageHost: web.url?.host, serverHost: AppConfig.serverHost) else { return nil }
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

    /// The page tells the app which company it shows; the bar and the Menu list are asked again about THAT company.
    func setSelection(_ query: String) async {
        guard query != selection else { return }
        selection = query
        await refreshMe()
    }

    /// Asks the server who this person is and what they can open (the bar and the Menu come from the answer). Not signed in or the app switched off = no bar;
    /// a hiccup (a server fault, no connection) KEEPS the bar the person already has.
    func refreshMe() async {
        guard !signingOut, let web, PageRules.mayRunRequest(pageHost: web.url?.host, serverHost: AppConfig.serverHost) else { return }
        if PageRules.isLoginPath(currentPath) { sawLoginPage = true }
        let epoch = meEpoch
        let result = await pageRequest(method: "GET", path: SelectionRules.meAddress(selection: selection), body: nil)
        // a sign-out happened while this was on its way: the answer is about the person who left
        guard epoch == meEpoch, !signingOut else { return }
        let outcome = MeRules.outcome(status: result?.0)
        meOutcome = outcome
        switch outcome {
        case .signedIn:
            guard let text = result?.1, let data = text.data(using: .utf8), let decoded = try? JSONDecoder().decode(Me.self, from: data) else { return }
            me = decoded
            // someone signed in on the sign-in page (maybe as another person, without signing out first): save the phone again for whoever is signed in now
            if sawLoginPage && !PageRules.isLoginPath(currentPath) { registeredToken = nil; lastRegisterFailure = nil; sawLoginPage = false }
            await checkAlerts()
            await registerDevice()
        case .signedOut, .off:
            me = nil
            registeredToken = nil
        case .unavailable:
            break
        }
    }

    /// Saves this phone for alerts once there is both a token and a signed-in person (once per token; again after a sign-out and a new sign-in).
    func registerDevice() async {
        guard !signingOut, let token = deviceToken, me != nil, registeredToken != token,
              RegistrationRules.mayRetry(lastFailure: lastRegisterFailure, now: Date()) else { return }
        let body: [String: Any] = [
            "token": token, "bundleId": AppConfig.bundleId, "apnsEnv": AppConfig.apnsEnv, "deviceName": UIDevice.current.name,
            "appVersion": AppConfig.version, "appBuild": AppConfig.build,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: body), let json = String(data: data, encoding: .utf8) else { return }
        let epoch = meEpoch
        if let (status, text) = await pageRequest(method: "PUT", path: "/api/portal/app/devices", body: json) {
            guard epoch == meEpoch, !signingOut else { return }
            if status == 200 { registeredToken = token; lastRegisterFailure = nil; UserDefaults.standard.set(token, forKey: tokenKey) } else { lastRegisterFailure = Date() }
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
    /// If the server could not be told (no connection ...) the person stays signed in and is asked to try again: ending the sign-in anyway would leave this
    /// phone saved under the old person.
    func signOut() async {
        guard !signingOut else { return }
        signingOut = true
        meEpoch += 1
        defer { signingOut = false }
        var removal: Int? = 200      // nothing to tell the server when this phone was never saved
        if let token = deviceToken ?? UserDefaults.standard.string(forKey: tokenKey) {
            let body = try? JSONSerialization.data(withJSONObject: ["token": token, "bundleId": AppConfig.bundleId])
            removal = await pageRequest(method: "DELETE", path: "/api/portal/app/devices", body: body.flatMap { String(data: $0, encoding: .utf8) })?.0
        }
        guard SignOutRules.mayEndSession(removalStatus: removal) else { signOutFailed = true; return }
        signOutFailed = false
        UserDefaults.standard.removeObject(forKey: tokenKey)
        registeredToken = nil
        lastRegisterFailure = nil
        sawLoginPage = false
        me = nil
        meOutcome = .signedOut
        selection = ""
        sheet = nil
        alertsPending = false
        let center = UNUserNotificationCenter.current()
        try? await center.setBadgeCount(0)
        center.removeAllDeliveredNotifications()   // the person who left must not leave their alerts on the lock screen
        let store = WKWebsiteDataStore.default()
        await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        meEpoch += 1
        loadFailed = false
        failedURL = nil
        webEpoch += 1                              // a brand-new web view (it opens the portal's sign-in page): no page of the person who left stays in its history
    }
}
