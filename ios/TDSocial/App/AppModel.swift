// The app's state: who is signed in, which tabs, the alerts permission, the phone registration, the icon number.
// The server decides what a person may see (GET /api/marketing/app/me); the app only draws it.
import SwiftUI
import WebKit
import UserNotifications
import Network

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    enum Screen: Equatable { case checking, signedOut, notSwitchedOn, problem(String), noAccess, ready }

    @Published var screen: Screen = .checking
    @Published var me: AppMe?
    @Published var selectedTab = ""
    @Published var offline = false
    @Published var showAlertsSheet = false
    @Published var alertsAuthorized = false
    /// the "You" screen is open (asked for by the round button inside a web screen, or by the failed-page overlay)
    @Published var showYou = false
    @Published var signInHost = WebHost(path: TabPath.signInPath)

    private var hosts: [String: WebHost] = [:]
    private let monitor = NWPathMonitor()
    private var checking = false
    private var prefsEdits = 0   // counts switch changes on the You screen; a check that began before one is out of date
    private var warmed = false   // the waiting tabs' pages have been started (reset when the person signs out)
    private let askedKey = "alertsAsked.\(AppConfig.bundleId)"
    private let tokenKey = "lastPushToken.\(AppConfig.bundleId)"

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in Task { @MainActor in self?.offline = path.status != .satisfied } }
        monitor.start(queue: DispatchQueue(label: "td.net"))
        signInHost.onFinish = { [weak self] in Task { @MainActor in await self?.check() } }
    }

    func start() async {
        #if DEBUG
        await API.installDevSessionIfPresent()
        #endif
        await check()
    }

    // MARK: who am I

    /// `force` runs even while another check is under way (after a switch change the screen must re-read the server, not wait for the next minute).
    func check(force: Bool = false) async {
        if checking && !force { return }
        checking = true
        let editsAtStart = prefsEdits
        defer { checking = false }
        let r = await API.request("/api/marketing/app/me")
        if editsAtStart != prefsEdits { return }   // a switch changed while this answer was on its way: that change re-reads after its own save
        switch SessionCheck.classify(status: r.status, body: r.body) {
        case .signedIn(let me): apply(me)
        case .needsSignIn: if screen != .signedOut { enterSignedOut() }
        case .notSwitchedOn: screen = .notSwitchedOn
        case .failed(let why): if screen != .ready { screen = .problem(why) }   // a signed-in app that loses the connection keeps showing its pages
        }
    }

    private func apply(_ me: AppMe) {
        self.me = me
        if me.notSetUp { screen = .noAccess; return }
        if selectedTab == "" || !me.tabs.contains(where: { $0.id == selectedTab }) { selectedTab = me.tabs.first?.id ?? "" }
        if screen != .ready { screen = .ready }
        #if DEBUG
        if let open = API.takeDevOpen(), me.tabs.contains(where: { $0.id == open.tab }) { selectedTab = open.tab; host(for: open.tab).load(open.path) }   // simulator tests only
        #endif
        if let b = me.badge { UNUserNotificationCenter.current().setBadgeCount(b) { _ in } }
        Task { await refreshAlertState() }
    }

    private func enterSignedOut() {
        me = nil
        hosts.removeAll()
        warmed = false
        signInHost = WebHost(path: TabPath.signInPath)
        signInHost.onFinish = { [weak self] in Task { @MainActor in await self?.check() } }
        screen = .signedOut
    }

    /// Only the tab on screen starts loading when the app opens; the others wait (TabLoading) so the first screen has the phone's connection to itself.
    func host(for tabId: String) -> WebHost {
        if let h = hosts[tabId] { return h }
        let first = TabLoading.loadsAtOnce(tabId: tabId, selected: selectedTab)
        let h = WebHost(path: TabPath.path(for: tabId) ?? "/", loadNow: first)
        if first {
            // when the first page is in, the others start a moment later; if it never gets in, they start anyway after a while
            h.onFinish = { [weak self] in Task { @MainActor in self?.scheduleWarming(after: TabLoading.warmDelay) } }
            scheduleWarming(after: TabLoading.warmFallback)
        }
        hosts[tabId] = h
        return h
    }

    /// starts the waiting tabs' pages in the background, once (the first call that fires wins)
    private func scheduleWarming(after seconds: TimeInterval) {
        if warmed { return }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !warmed, screen == .ready else { return }
            warmed = true
            for id in TabLoading.warmOrder(tabs: me?.tabs.map { $0.id } ?? [], selected: selectedTab) { hosts[id]?.startIfNeeded() }
        }
    }

    // MARK: tabs, alerts that arrive, the Inbox "seen" time

    func tabChanged() {
        hosts[selectedTab]?.startIfNeeded()   // a tab that was still waiting starts the moment the person opens it
        if selectedTab == "inbox" { Task { await markInboxSeen() } }
    }

    func becameActive() {
        Task {
            await check()
            if selectedTab == "inbox" { await markInboxSeen() }
        }
    }

    /// "I opened my Inbox now": resets the new-mail number for each mailbox this person may open (server clock, only moves forward)
    func markInboxSeen() async {
        guard let inbox = me?.tabs.first(where: { $0.id == "inbox" }) else { return }
        for mailbox in inbox.mailboxes ?? [] { _ = await API.request("/api/marketing/app/seen", method: "POST", json: ["mailbox": mailbox]) }
        await check()
    }

    /// The person tapped an alert: open the tab it belongs to (and the exact page when the alert carried a safe link)
    func openFromAlert(url: String?, thread: String?) {
        guard let tab = AlertRouting.tab(url: url, thread: thread), me?.tabs.contains(where: { $0.id == tab }) == true else { return }
        selectedTab = tab
        if let path = AlertRouting.safeRelativePath(url) { host(for: tab).load(path) }
    }

    // MARK: alerts permission and the phone registration

    func refreshAlertState() async {
        let s = await UNUserNotificationCenter.current().notificationSettings()
        alertsAuthorized = s.authorizationStatus == .authorized || s.authorizationStatus == .provisional
        if alertsAuthorized { UIApplication.shared.registerForRemoteNotifications(); return }
        if s.authorizationStatus == .notDetermined && !UserDefaults.standard.bool(forKey: askedKey) && me?.notSetUp == false { showAlertsSheet = true }
    }

    func turnOnAlerts() async {
        UserDefaults.standard.set(true, forKey: askedKey)
        showAlertsSheet = false
        let center = UNUserNotificationCenter.current()
        let s = await center.notificationSettings()
        if s.authorizationStatus == .denied { openIPhoneSettings(); return }
        if (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) == true { UIApplication.shared.registerForRemoteNotifications() }
        await refreshAlertState()
    }

    func skipAlerts() { UserDefaults.standard.set(true, forKey: askedKey); showAlertsSheet = false }

    func openIPhoneSettings() { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } }

    func registerDevice(token: String) async {
        UserDefaults.standard.set(token, forKey: tokenKey)
        guard screen == .ready else { return }
        let body = DeviceBody.registration(token: token, bundleId: AppConfig.bundleId, apnsEnv: AppConfig.apnsEnv, deviceName: UIDevice.current.name, appVersion: AppConfig.version, appBuild: AppConfig.build)
        let r = await API.request("/api/marketing/app/devices", method: "PUT", json: body)
        if r.status != 200 { NSLog("[TDSocial] phone registration answered %d", r.status) }
    }

    // MARK: the You screen

    func setAlert(_ key: String, _ on: Bool) async {
        if let m = me { me = m.withPrefs(m.prefs.settingAlert(key, on)) }   // the switch moves at once
        prefsEdits += 1
        _ = await API.request("/api/marketing/app/prefs", method: "PUT", json: ["alerts": [key: on]])
        await check(force: true)   // the server's answer wins (a failed save puts the switch back)
    }

    /// Mute (true) or unmute (false) whole tabs: a muted tab sends no alert and is left out of the icon number (the server's own rule).
    func setMute(_ tabIds: [String], _ muted: Bool) async {
        var change: [String: Bool] = [:]
        for t in tabIds { change[t] = muted }
        if let m = me { me = m.withPrefs(m.prefs.settingMute(tabIds, muted)) }   // the switch moves at once
        prefsEdits += 1
        _ = await API.request("/api/marketing/app/prefs", method: "PUT", json: ["mute": change])
        await check(force: true)   // the server's answer wins (a failed save puts the switch back)
    }

    func sendTestAlert() async -> Bool {
        let r = await API.request("/api/admin/push/test", method: "POST")
        return r.status == 200
    }

    func signOut() async {
        if let token = UserDefaults.standard.string(forKey: tokenKey) {
            _ = await API.request("/api/marketing/app/devices", method: "DELETE", json: ["token": token, "bundleId": AppConfig.bundleId])
        }
        UserDefaults.standard.removeObject(forKey: tokenKey)
        let store = WKWebsiteDataStore.default()
        await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        UNUserNotificationCenter.current().setBadgeCount(0) { _ in }
        selectedTab = ""
        enterSignedOut()
    }
}
