import SwiftUI
import FileProvider
import AppKit

@main
struct TDStorageApp: App {
    @StateObject private var model = AppModel()
    var body: some Scene {
        WindowGroup("TD Storage") {
            ContentView().environmentObject(model).frame(minWidth: 420, minHeight: 300).task { await model.start() }
        }
        .windowResizability(.contentSize)
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
    /// A DEBUG build (the dev-server / test-data configuration) may run without FileVault: it only ever talks to the sandbox's TEST data.
    /// The Sandbox and (later) Production configurations always require it. Never ship a Debug build to a real user.
    #if DEBUG
    let fileVaultRequired = false
    #else
    let fileVaultRequired = true
    #endif

    private let info = Bundle.main.infoDictionary ?? [:]
    private lazy var baseURL = URL(string: info["TDServerURL"] as? String ?? "https://invalid.example")!
    private lazy var store = KeychainTokenStore(service: info["TDKeychainService"] as? String ?? "td-storage", accessGroup: info["TDKeychainGroup"] as? String)
    private lazy var lease = KeychainLeaseStore(service: info["TDKeychainService"] as? String ?? "td-storage", accessGroup: info["TDKeychainGroup"] as? String)
    private lazy var api = StorageAPI(baseURL: baseURL, store: store, lease: lease)
    private var leaseTimer: Timer?
    private var wakeObserver: NSObjectProtocol?
    private let domain = NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier(rawValue: "td-storage"), displayName: "TD Storage")
    private var flow: LoopbackSignIn?

    var deviceName: String { Host.current().localizedName ?? "This Mac" }
    var serverLabel: String { baseURL.host ?? "" }

    func start() async {
        fileVaultOK = FileVaultCheck.isOn()
        guard store.load() != nil else { state = .signedOut; return }
        // an install from before the lease existed has tokens but no record: start the lease now (the server enforces the real 24 hours)
        if lease.lastContact() == nil { lease.touch() }
        if lease.isExpired() { await wipe(); state = .problem(leaseMessage); return }
        startLeaseWatch()
        do {
            let me = try await api.whoami()
            state = .signedIn(me.email ?? "signed in")
            do { try await register() } catch {
                let ns = error as NSError
                state = .problem("Signed in, but macOS would not add TD Storage to Finder (\(ns.domain) \(ns.code): \(ns.localizedDescription)).")
            }
        } catch StorageAPIError.deviceRevoked { await wipe(); state = .signedOut }
        catch StorageAPIError.notSignedIn { await wipe(); state = .signedOut }
        catch { state = .problem("Could not reach the CRM. Check your internet connection.") }
    }

    func signIn() async {
        guard fileVaultOK || !fileVaultRequired else { state = .problem("Turn on FileVault (System Settings › Privacy & Security) before using TD Storage: client documents must never sit on a disk that is not encrypted."); return }
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
        do { _ = try await api.whoami() }
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

    private func register() async throws { try await NSFileProviderManager.add(domain) }

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
