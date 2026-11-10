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
