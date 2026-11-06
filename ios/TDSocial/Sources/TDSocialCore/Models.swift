// What the server's "who am I?" answer looks like (GET /api/marketing/app/me). Mirrors lib/app/me.ts on the server; unknown fields are ignored.
import Foundation

public struct AppTabInfo: Codable, Equatable, Identifiable {
    public let id: String
    public let label: String
    public let mailboxes: [String]?
    public init(id: String, label: String, mailboxes: [String]? = nil) { self.id = id; self.label = label; self.mailboxes = mailboxes }
}

public struct AppUser: Codable, Equatable {
    public let id: String
    public let email: String?
    public let name: String
    public init(id: String, email: String?, name: String) { self.id = id; self.email = email; self.name = name }
}

public struct AppPrefs: Codable, Equatable {
    public let mutedTabs: [String]
    /// present only when the person has the WhatsApp tab
    public let whatsapp: Bool?
    /// present only when the person has the Inbox tab: one switch per mailbox they may open
    public let email: [String: Bool]?
    public init(mutedTabs: [String] = [], whatsapp: Bool? = nil, email: [String: Bool]? = nil) { self.mutedTabs = mutedTabs; self.whatsapp = whatsapp; self.email = email }

    /// The same settings with these tabs muted (true) or brought back (false). The You screen shows a switch change at once with this,
    /// before the server has confirmed it; the server's own answer replaces it a moment later.
    public func settingMute(_ tabIds: [String], _ muted: Bool) -> AppPrefs {
        var set = Set(mutedTabs)
        for t in tabIds { if muted { set.insert(t) } else { set.remove(t) } }
        return AppPrefs(mutedTabs: set.sorted(), whatsapp: whatsapp, email: email)
    }

    /// The same settings with one "which new messages alert you" switch changed: key is "whatsapp" or "email:<mailbox>" (as the server takes it).
    public func settingAlert(_ key: String, _ on: Bool) -> AppPrefs {
        if key == "whatsapp" { return AppPrefs(mutedTabs: mutedTabs, whatsapp: whatsapp == nil ? nil : on, email: email) }
        if key.hasPrefix("email:"), var boxes = email {
            boxes[String(key.dropFirst("email:".count))] = on
            return AppPrefs(mutedTabs: mutedTabs, whatsapp: whatsapp, email: boxes)
        }
        return self
    }
}

public struct AppMe: Codable, Equatable {
    public let ok: Bool
    public let user: AppUser
    /// "staff" | "marketing" | "none"
    public let loginKind: String
    public let tabs: [AppTabInfo]
    /// true when the login has no tab at all
    public let notSetUp: Bool
    public let prefs: AppPrefs
    /// unread per not-muted tab; a value is null when that tab could not be counted; null as a whole when nothing could be counted
    public let counts: [String: Int?]?
    /// the icon number, or null when any tab could not be counted (the app then keeps the number it has)
    public let badge: Int?

    public init(ok: Bool = true, user: AppUser, loginKind: String, tabs: [AppTabInfo], notSetUp: Bool = false, prefs: AppPrefs = AppPrefs(), counts: [String: Int?]? = nil, badge: Int? = nil) {
        self.ok = ok; self.user = user; self.loginKind = loginKind; self.tabs = tabs; self.notSetUp = notSetUp; self.prefs = prefs; self.counts = counts; self.badge = badge
    }

    /// the count to show on a tab (0 = show nothing)
    public func count(for tabId: String) -> Int {
        guard let all = counts, let entry = all[tabId], let n = entry, n > 0 else { return 0 }
        return n
    }

    public var isMarketingOnly: Bool { loginKind == "marketing" }

    /// The same answer with other alert settings (everything else untouched).
    public func withPrefs(_ prefs: AppPrefs) -> AppMe {
        AppMe(ok: ok, user: user, loginKind: loginKind, tabs: tabs, notSetUp: notSetUp, prefs: prefs, counts: counts, badge: badge)
    }
}
