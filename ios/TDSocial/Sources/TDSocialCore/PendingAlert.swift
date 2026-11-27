// A tapped alert that must wait (dev job 64ee2a3f, 27 Nov 2026).
//
// When the person taps an alert while the app is CLOSED, the tap is what starts the app, and it is delivered before the server has said which tabs this
// person has (and, when the sign-in has run out, before the person has signed in). The old code looked at the tab list right then, found none and threw the
// tap away: the app opened on its first tab, TD Talk, whatever the alert was about (reproduced in the simulator with a portal-chat alert).
//
// The fix: keep the tap, and use it the moment the tab list is known. A kept tap is only good for a short time, so one that was never used (the person
// walked away from a sign-in screen) can never jump the app to a chat minutes later.

import Foundation

/// Where a tapped alert goes: a tab, and the exact page inside it when the alert carried a safe link.
public struct AlertTarget: Equatable {
    public let tab: String
    public let path: String?
    public init(tab: String, path: String?) { self.tab = tab; self.path = path }
}

extension AlertRouting {
    /// The tab (and page) a tapped alert opens for a person who has `tabs`. nil = the alert names no tab, or this person does not have that tab.
    public static func target(url: String?, thread: String?, tabs: [String]) -> AlertTarget? {
        guard let tab = AlertRouting.tab(url: url, thread: thread), tabs.contains(tab) else { return nil }
        return AlertTarget(tab: tab, path: AlertRouting.pagePath(url: url))
    }
}

/// A tapped alert waiting for the tab list.
public struct PendingAlert: Equatable {
    /// How long a kept tap stays good. A cold start and a sign-in take seconds; five minutes covers a slow sign-in and no more.
    public static let lifetime: TimeInterval = 300

    public let url: String?
    public let thread: String?
    public let receivedAt: Date

    public init(url: String?, thread: String?, receivedAt: Date) {
        self.url = url; self.thread = thread; self.receivedAt = receivedAt
    }

    /// Still worth opening? (A clock that moved backwards makes the age negative: that still counts as fresh, never as expired.)
    public func isFresh(at now: Date) -> Bool { now.timeIntervalSince(receivedAt) <= PendingAlert.lifetime }

    /// Where this tap goes for a person who has `tabs`, or nil when it is too old or names no tab this person has.
    public func target(tabs: [String], now: Date) -> AlertTarget? {
        guard isFresh(at: now) else { return nil }
        return AlertRouting.target(url: url, thread: thread, tabs: tabs)
    }
}
