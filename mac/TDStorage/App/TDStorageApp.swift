import SwiftUI
import FileProvider
import AppKit
import Sparkle
import ServiceManagement

@main
struct TDStorageApp: App {
    @StateObject private var model = AppModel()
    // Automatic updates (Sparkle 2): the app asks the CRM's update feed at every start and then hourly (the CRM can change the pace), downloads a
    // newer signed version by itself and installs it + reopens once the app is idle. Nobody has to do anything. Which version is offered
    // (or none: paused / gradual roll-out) is decided by the CRM, never by the app.
    private static let gate = UpdateGate()
    private let updater = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: TDStorageApp.gate, userDriverDelegate: nil)
    init() {
        let u = updater.updater
        TDStorageApp.gate.updater = u
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { u.checkForUpdatesInBackground() }
    }
    var body: some Scene {
        WindowGroup("TD Storage") {
            ContentView().environmentObject(model).frame(minWidth: 420, minHeight: 300)
                .task { model.onNewerBuild = { TDStorageApp.gate.checkNow() }; await model.start(); TDStorageApp.gate.setInterval(minutes: model.updateCheckMinutes) }
        }
        .windowResizability(.contentSize)
    }
}

/// Sparkle's delegate: installs a downloaded update right away (and reopens the app) instead of waiting for the app to be quit, and tells the
/// CRM which Mac is asking (the CRM uses it for gradual roll-outs). The check pace is the CRM's `updateCheckMinutes` setting (never below an hour).
final class UpdateGate: NSObject, SPUUpdaterDelegate {
    weak var updater: SPUUpdater?
    /// Look for an update right now (the CRM said a newer build is offered to this Mac). Sparkle ignores it while a check or download is already running.
    func checkNow() { updater?.checkForUpdatesInBackground() }
    func setInterval(minutes: Double?) {
        guard let m = minutes, m >= 60, let u = updater else { return }
        u.updateCheckInterval = m * 60
    }
    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem, immediateInstallationBlock immediateInstallHandler: @escaping () -> Void) -> Bool {
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { immediateInstallHandler() }
        return true
    }
    func feedParameters(for updater: SPUUpdater, sendingSystemProfile sendingProfile: Bool) -> [[String: String]] {
        let info = Bundle.main.infoDictionary ?? [:]
        let store = KeychainTokenStore(service: info["TDKeychainService"] as? String ?? "td-storage", accessGroup: info["TDKeychainGroup"] as? String)
        var out: [[String: String]] = []
        if let d = store.load()?.deviceId { out.append(["key": "device", "value": d]) }
        return out
    }
}

enum SignInState: Equatable {
    case checking
    case signedOut
    case waiting(checkCode: String, link: URL)   // the browser approval page is open; the code shown here must match the page's
    case signedIn(String)
    case problem(String)
}

@MainActor
final class AppModel: ObservableObject {
    @Published var state: SignInState = .checking
    @Published var fileVaultOK = true
    @Published var browserProblem: String?
    /// how often the CRM wants this Mac to look for a new version (nil until the CRM has said)
    @Published var updateCheckMinutes: Double?
    /// set by the app: look for an update now. Called at most every 10 minutes, when the CRM reports a build newer than this one.
    var onNewerBuild: (() -> Void)?
    private var lastUpdateNudge = Date.distantPast
    private var currentBuild: Int { Int((info["CFBundleVersion"] as? String) ?? "") ?? 0 }
    private func noteLatest(_ latest: Int?) {
        guard let latest, latest > currentBuild, Date().timeIntervalSince(lastUpdateNudge) > 600 else { return }
        lastUpdateNudge = Date()
        onNewerBuild?()
    }
    /// FileVault is NO LONGER required (Antonio, 2026-10-17: the Mac mini is a server and must restart its services by itself, so its disk
    /// stays unencrypted). Instead the CRM tells every Mac to remove its copy of an opened file after 15 minutes (2 minutes for passports,
    /// IDs and ITIN papers). The app only shows a note when FileVault is off.
    let fileVaultRequired = false

    private let info = Bundle.main.infoDictionary ?? [:]
    private lazy var baseURL = URL(string: info["TDServerURL"] as? String ?? "https://invalid.example")!
    private lazy var store = KeychainTokenStore(service: info["TDKeychainService"] as? String ?? "td-storage", accessGroup: info["TDKeychainGroup"] as? String)
    private lazy var lease = KeychainLeaseStore(service: info["TDKeychainService"] as? String ?? "td-storage", accessGroup: info["TDKeychainGroup"] as? String)
    private lazy var api = StorageAPI(baseURL: baseURL, store: store, lease: lease)
    private var leaseTimer: Timer?
    private var wakeObserver: NSObjectProtocol?
    // the name Finder shows: "TD Storage" in the real app, "TD Storage (test)" / "(sandbox)" in the other builds so they can sit side by side
    private let domain = NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier(rawValue: "td-storage"), displayName: (Bundle.main.infoDictionary?["TDDomainName"] as? String) ?? "TD Storage")
    private var flow: LoopbackSignIn?

    var deviceName: String { Host.current().localizedName ?? "This Mac" }
    var serverLabel: String { baseURL.host ?? "" }
    var versionLabel: String { "\(info["CFBundleShortVersionString"] as? String ?? "?") (\(info["CFBundleVersion"] as? String ?? "?"))" }

    func start() async {
        fileVaultOK = FileVaultCheck.isOn()
        guard store.load() != nil else { state = .signedOut; return }
        // an install from before the lease existed has tokens but no record: start the lease now (the server enforces the real 24 hours)
        if lease.lastContact() == nil { lease.touch() }
        if lease.isExpired() { await wipe(); state = .problem(leaseMessage); return }
        startLeaseWatch()
        do {
            let me = try await api.whoami()
            updateCheckMinutes = me.updateCheckMinutes
            noteLatest(me.latestBuild)
            state = .signedIn(me.email ?? "signed in")
            enableStartAtLogin()
            do { try await register() } catch {
                let ns = error as NSError
                state = .problem("Signed in, but macOS would not add TD Storage to Finder (\(ns.domain) \(ns.code): \(ns.localizedDescription)).")
            }
        } catch StorageAPIError.deviceRevoked { await wipe(); state = .signedOut }
        catch StorageAPIError.notSignedIn { await wipe(); state = .signedOut }
        catch { state = .problem("Could not reach the CRM. Check your internet connection.") }
    }

    func signIn() async {
        let verifier = PKCE.makeVerifier()
        let challenge = PKCE.challenge(for: verifier)
        let checkCode = PKCE.checkCode(for: challenge)
        let flow = LoopbackSignIn()
        self.flow = flow
        do {
            let started = try await flow.start(baseURL: baseURL, deviceName: deviceName, challenge: challenge, state: PKCE.makeState(), checkCode: checkCode)
            state = .waiting(checkCode: checkCode, link: started.approvalURL)
            openInBrowser(started.approvalURL)
            let code = try await flow.waitForCode()
            _ = try await api.exchange(code: code, verifier: verifier, redirectURI: started.redirectURI)
            let me = try await api.whoami()      // the CRM answered: the 24-hour lease starts
            updateCheckMinutes = me.updateCheckMinutes
            enableStartAtLogin()
            try await register()
            startLeaseWatch()
            state = .signedIn(me.email ?? "signed in")
        } catch LoopbackSignIn.SignInError.timedOut { state = .problem("The sign-in took too long. Try again.") }
        catch StorageAPIError.forbidden(let why) { state = .problem(why) }
        catch {
            let ns = error as NSError
            state = .problem("The sign-in did not complete (\(ns.domain) \(ns.code): \(ns.localizedDescription)). Try again.")
        }
        self.flow = nil
    }

    /// Opens the CRM approval page in the person's default browser; if macOS cannot, the window says so (and offers the link).
    func openInBrowser(_ url: URL) {
        NSWorkspace.shared.open(url, configuration: NSWorkspace.OpenConfiguration()) { _, error in
            if let error { Task { @MainActor in self.browserProblem = "Could not open the browser: \(error.localizedDescription). Use Copy link and paste it into Chrome or Safari." } }
        }
    }

    func copy(_ url: URL) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url.absoluteString, forType: .string)
    }

    private let leaseMessage = "This Mac was offline from the CRM for more than 24 hours, so TD Storage signed itself out and cleared the folder. Sign in again."

    /// Every few minutes: has this Mac been in contact with the CRM within 24 hours? If not → sign out and clear everything that was downloaded.
    private func startLeaseWatch() {
        leaseTimer?.invalidate()
        leaseTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.checkLease() }
        }
        // the Finder extension is not always alive (the system may stop it, the Mac may sleep): the app itself also keeps in touch,
        // every 5 minutes and right after the Mac wakes, so an ONLINE Mac never runs out of lease
        if wakeObserver == nil {
            wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in await self?.checkLease() }
            }
        }
    }

    /// Signed out and cleared if the lease ran out; otherwise ask the CRM "who am I" (a real answer restarts the 24 hours).
    private func checkLease() async {
        guard store.load() != nil else { return }
        if lease.isExpired() { await wipe(); state = .problem(leaseMessage); return }
        do { noteLatest(try await api.whoami().latestBuild) }
        catch StorageAPIError.deviceRevoked { await wipe(); state = .signedOut }
        catch StorageAPIError.notSignedIn { await wipe(); state = .signedOut }
        catch { /* offline for now: the lease keeps running */ }
    }

    func signOut() async { await wipe(); state = .signedOut }

    func openInFinder() {
        NSFileProviderManager(for: domain)?.getUserVisibleURL(for: .rootContainer) { url, _ in
            if let url { NSWorkspace.shared.open(url) }
        }
    }

    /// The app must be running for updates to arrive, so it starts by itself when the person logs in (a small window; macOS lists it under Login Items).
    private func enableStartAtLogin() { try? SMAppService.mainApp.register() }

    /// Adds TD Storage to Finder. When a NEW version changes how Finder is laid out (the Info key TDLayoutVersion), the location is made again once,
    /// because Finder remembers the order it first saw (see docs/systems/storage-app.md) — so an update never needs anyone to sign out and in.
    private func register() async throws {
        let layout = (info["TDLayoutVersion"] as? String) ?? "0"
        let key = "td.layoutRegistered"
        if let seen = UserDefaults.standard.string(forKey: key), seen != layout { try? await NSFileProviderManager.remove(domain) }
        try await NSFileProviderManager.add(domain)
        UserDefaults.standard.set(layout, forKey: key)
    }

    private func wipe() async {
        leaseTimer?.invalidate()
        store.clear()
        lease.clear()
        try? await NSFileProviderManager.remove(domain)     // removes the TD Storage location and everything cached for it
    }
}

enum FileVaultCheck {
    /// `fdesetup status` answers "FileVault is On." — asked locally; a server-side check could be spoofed.
    static func isOn() -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/fdesetup")
        p.arguments = ["status"]
        let pipe = Pipe(); p.standardOutput = pipe; p.standardError = Pipe()
        do { try p.run(); p.waitUntilExit() } catch { return false }
        let text = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return text.contains("FileVault is On")
    }
}
