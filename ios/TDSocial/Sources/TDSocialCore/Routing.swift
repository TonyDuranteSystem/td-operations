// Which web page each tab shows, and what an alert opens. Pure, so it is unit-tested without a phone.
import Foundation

public enum TabPath {
    /// the page of each tab (the existing screens; app mode is switched on by the browser name, see ServerRules.userAgentToken)
    public static func path(for tabId: String) -> String? {
        switch tabId {
        case "talk": return "/talk"
        case "portal": return "/portal-chats"
        case "whatsapp": return "/inbox?channel=whatsapp"
        case "inbox": return "/inbox"
        case "marketing": return "/marketing/chat"
        default: return nil
        }
    }

    /// short names for the tab bar ("Portal", not "Portal chats", which truncates at larger text)
    public static func shortLabel(for tabId: String, fallback: String) -> String {
        switch tabId {
        case "talk": return "TD Talk"
        case "portal": return "Portal"
        case "whatsapp": return "WhatsApp"
        case "inbox": return "Inbox"
        case "marketing": return "Marketing"
        default: return fallback
        }
    }

    /// the page that signs a person in (staff and marketing logins use the same one)
    public static let signInPath = "/login"
}

public enum ServerRules {
    /// the one thing that switches the web screens into app mode (lib/app-mode/app-mode.ts on the server: exact, case-sensitive)
    public static let userAgentToken = "TDSocial/"
}

public enum AlertRouting {
    /// Which tab an alert opens. `url` = the relative link the server sent (if any); `thread` = the alert's grouping id (the server's tag).
    /// The link wins; otherwise the tag's prefix says which kind of alert it is. nil = open nothing special.
    public static func tab(url: String?, thread: String?) -> String? {
        if let path = safeRelativePath(url) {
            let lower = path.lowercased()
            if lower.hasPrefix("/talk") { return "talk" }
            if lower.hasPrefix("/portal-chats") { return "portal" }
            if lower.hasPrefix("/marketing") { return "marketing" }
            if lower.hasPrefix("/inbox") { return lower.contains("channel=whatsapp") ? "whatsapp" : "inbox" }
        }
        if let t = thread?.lowercased() {
            if t.hasPrefix("whatsapp:") { return "whatsapp" }
            if t.hasPrefix("email:") { return "inbox" }
        }
        return nil
    }

    /// A link from an alert is followed only when it is a same-site relative path (never another address, never a script). nil = not safe.
    public static func safeRelativePath(_ url: String?) -> String? {
        guard let u = url, u.hasPrefix("/"), !u.hasPrefix("//"), !u.contains("\\"), !u.contains(" "), u.count <= 500 else { return nil }
        if u.rangeOfCharacter(from: .controlCharacters) != nil { return nil }
        return u
    }
}

public enum LinkRules {
    /// Pages of OUR server stay inside the app; everything else (other sites, file links) opens in Safari.
    public static func staysInApp(host: String?, serverHost: String) -> Bool {
        guard let h = host?.lowercased() else { return false }
        return h == serverHost.lowercased()
    }
}
