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
            // the server builds TD Talk alert links as /team-chat?thread=…&message=… (the CRM's Team Chat address): that is the TD Talk tab here
            if isTeamChat(lower) { return "talk" }
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

    /// True for the CRM's Team Chat address (`/team-chat`, `/team-chat?…`, `/team-chat/…`), never for a longer word such as `/team-chatter`.
    static func isTeamChat(_ lowerPath: String) -> Bool {
        guard lowerPath.hasPrefix("/team-chat") else { return false }
        let rest = lowerPath.dropFirst("/team-chat".count)
        return rest.isEmpty || rest.first == "?" || rest.first == "#" || rest.first == "/"
    }

    /// The page to load for a tapped alert: the safe link, with the CRM's Team Chat address turned into the TD Talk page (the same rule as the web side,
    /// lib/talk/paths.ts `talkUrlFor`): `/team-chat?thread=A&message=B` → `/talk?thread=A&message=B`. Without this the phone would load the CRM's
    /// Team Chat page inside the TD Talk tab. Anything else is returned unchanged; nil = not a safe link.
    public static func pagePath(url: String?) -> String? {
        guard let path = safeRelativePath(url) else { return nil }
        guard isTeamChat(path.lowercased()) else { return path }
        // keep only the query/fragment (the web rule drops a sub-path too)
        let cut = path.firstIndex(where: { $0 == "?" || $0 == "#" })
        return "/talk" + (cut.map { String(path[$0...]) } ?? "")
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

/// Which alerts on the lock screen / in the Notification Centre should go away because the person has read what they were about.
public enum ReadAlerts {
    public struct Delivered { public let id: String; public let url: String?; public let thread: String?
        public init(id: String, url: String?, thread: String?) { self.id = id; self.url = url; self.thread = thread } }

    /// The ids to remove: every delivered alert whose tab the server says has nothing unread. An alert that belongs to no known tab, or a tab whose count is
    /// unknown (missing / failed), is NEVER removed.
    public static func idsToClear(delivered: [Delivered], me: AppMe) -> [String] {
        delivered.compactMap { d in
            guard let tab = AlertRouting.tab(url: d.url, thread: d.thread), me.isKnownRead(tab) else { return nil }
            return d.id
        }
    }

    /// The ids of the other delivered alerts of the same conversation (same thread id) as the one just tapped: they are read too.
    public static func idsOfSameThread(as thread: String?, delivered: [Delivered]) -> [String] {
        guard let t = thread, !t.isEmpty else { return [] }
        return delivered.filter { $0.thread == t }.map { $0.id }
    }
}
