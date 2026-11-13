// The rules of the client app's web view that do not need a phone to be tested: which links stay inside the app, which address an alert may open,
// and the browser name that switches the portal into app mode. Pure, so every rule is unit-tested (`swift test`).
import Foundation

public enum ServerRules {
    /// The one thing that switches the portal's pages into app mode (lib/app-mode/app-mode.ts on the server: `CLIENT_APP_UA_TOKEN`, exact and case-sensitive).
    public static let userAgentToken = "TDClient/"
}

public enum LinkRules {
    /// The website's own sibling for the portal host: the portal links to client forms and offers on `app.` (the same company, a different front door).
    static let productionPortalHost = "portal.tonydurante.us"
    static let productionSiblingHost = "app.tonydurante.us"

    /// Pages of OUR site: the server this build talks to, and (only on the live portal) its `app.` sibling.
    public static func ownSite(host: String?, serverHost: String) -> Bool {
        guard let h = host?.lowercased(), !h.isEmpty else { return false }
        let server = serverHost.lowercased()
        if h == server { return true }
        return server == productionPortalHost && h == productionSiblingHost
    }

    /// Stripe's card page: the portal's "Pay Now" sends the person there in the SAME window and Stripe sends them back to the portal afterwards.
    public static func isCardPage(host: String?) -> Bool {
        guard let h = host?.lowercased(), !h.isEmpty else { return false }
        return h == "stripe.com" || h.hasSuffix(".stripe.com")
    }

    /// Does a page the web view is about to open stay in the app? Our own pages and Stripe's card page do; everything else (other sites) opens in Safari.
    public static func staysInApp(host: String?, serverHost: String) -> Bool {
        ownSite(host: host, serverHost: serverHost) || isCardPage(host: host)
    }

    /// Only OUR site may use the microphone / camera (the phone itself still asks the person once).
    public static func mayUseMedia(host: String?, serverHost: String) -> Bool { ownSite(host: host, serverHost: serverHost) }
}

public enum AlertRouting {
    /// A link (from an alert, the Menu or the bar) is followed only when it is a same-site relative path: never another address, never a script.
    /// nil = not safe.
    public static func safeRelativePath(_ url: String?) -> String? {
        guard let u = url, u.hasPrefix("/"), !u.hasPrefix("//"), !u.contains("\\"), !u.contains(" "), u.count <= 500 else { return nil }
        if u.rangeOfCharacter(from: .controlCharacters) != nil { return nil }
        return u
    }
}

// MARK: - rules added after the bug hunt of 10 Nov 2026 (docs/systems/client-app.md → "Bug-hunt fixes")

/// Which company the page on screen is showing. The portal page tells the app (a message `selection:<query>` from the main frame of OUR site) because the
/// website's company cookies never reach the app's server doors; the app then asks `/api/portal/app/me` about THAT company.
public enum SelectionRules {
    static let prefix = "selection:"
    static let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789=&_.-")

    /// The query part of a `selection:` message ("" = nothing selected), or nil when the message is not a selection or its words are not plain ids/words.
    public static func query(from body: String) -> String? {
        guard body.hasPrefix(prefix) else { return nil }
        let q = String(body.dropFirst(prefix.count))
        guard q.count <= 200, q.unicodeScalars.allSatisfy({ allowed.contains($0) }) else { return nil }
        return q
    }

    public static func meAddress(selection: String) -> String {
        selection.isEmpty ? "/api/portal/app/me" : "/api/portal/app/me?\(selection)"
    }
}

/// What the server's answer to "who am I" means for the bottom bar.
public enum MeOutcome: Equatable {
    case signedIn       // 200: the bar and the Menu list come from the answer
    case signedOut      // 401 / 403: nobody signed in (or a login the app does not serve): no bar
    case off            // 503: the app is switched off on the server: no bar (the website's own pages show instead)
    case unavailable    // anything else (a server hiccup, no connection): KEEP the bar the person already has

    public var clearsBar: Bool { self == .signedOut || self == .off }
}

public enum MeRules {
    public static func outcome(status: Int?) -> MeOutcome {
        guard let s = status else { return .unavailable }
        switch s {
        case 200: return .signedIn
        case 401, 403: return .signedOut
        case 503: return .off
        default: return .unavailable
        }
    }
}

/// Which bottom-bar button is lit for the page on screen. TD Billing is drawn by the invoices page (`?tab=billing`), so the address alone is not enough.
public enum BarRules {
    public static func isActive(itemPath: String, currentPath: String, currentTab: String?) -> Bool {
        let path = itemPath.split(separator: "?").first.map(String.init) ?? itemPath
        if path == "/portal" { return currentPath == "/portal" }
        if path == "/portal/billing" { return currentPath.hasPrefix("/portal/billing") || (currentPath == "/portal/invoices" && currentTab == "billing") }
        if path == "/portal/invoices" { return currentPath.hasPrefix("/portal/invoices") && currentTab != "billing" }
        return currentPath.hasPrefix(path)
    }
}

public enum PageRules {
    /// The app's own questions to the server (who am I, save this phone) run inside the page, so they may run only while the page IS our server: on a card page
    /// or another site they would go to the wrong place with the wrong cookies.
    public static func mayRunRequest(pageHost: String?, serverHost: String) -> Bool {
        guard let h = pageHost?.lowercased(), !h.isEmpty else { return false }
        return h == serverHost.lowercased()
    }

    /// The portal's sign-in page. A person can sign in as someone else there without ever being signed out first, so the phone is saved again afterwards.
    public static func isLoginPath(_ path: String) -> Bool { path == "/portal/login" || path.hasPrefix("/portal/login/") }
}

public enum SignOutRules {
    /// The phone's login is ended only when the server could be told to forget the phone, or when there is nothing to tell (no session left, app switched off).
    /// No answer at all (offline), "slow down" and a real server fault mean: do NOT sign out yet, so the old person's alerts never keep reaching this phone.
    public static func mayEndSession(removalStatus: Int?) -> Bool {
        guard let s = removalStatus else { return false }
        if s == 429 { return false }
        if s >= 500 && s != 503 { return false }
        return true
    }
}

public enum AlertRefreshRules {
    /// An alert that arrives while the app is open: seconds after which the bar's numbers are asked for again. The first is at once (the number shows while the
    /// person is on another screen); the second waits for an open chat page to mark the message read, so a number the person already cleared by reading never stays on the bar.
    public static let delays: [TimeInterval] = [0, 4]
}

public enum RegistrationRules {
    /// After the server refused to save the phone (too many phones, a fault ...) the app does not ask again on every page change, only every few minutes.
    public static func mayRetry(lastFailure: Date?, now: Date, wait: TimeInterval = 600) -> Bool {
        guard let last = lastFailure else { return true }
        return now.timeIntervalSince(last) >= wait
    }
}
