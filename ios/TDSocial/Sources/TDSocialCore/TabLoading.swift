// When each tab's page starts loading ("TD Talk opens slowly" fix C, 6 Nov 2026). Before, every tab's page started at the same moment the app opened, so the
// tab on screen shared the phone's connection with four other pages it was not showing. Now the tab on screen loads first; the others follow a moment after its
// page is in (or after a fallback time), or at once when the person opens one. Pure, so it is unit-tested without a phone.
import Foundation

public enum TabLoading {
    /// how long after the first page is in the other tabs start loading in the background
    public static let warmDelay: TimeInterval = 1.5
    /// the other tabs start anyway after this long, even if the first page never finished (a slow or failed first page must not leave them cold forever)
    public static let warmFallback: TimeInterval = 10

    /// does this tab's page start the moment the app opens? Only the tab on screen.
    public static func loadsAtOnce(tabId: String, selected: String) -> Bool {
        tabId == selected
    }

    /// the tabs that wait, in the order they start (the tab bar's order)
    public static func warmOrder(tabs: [String], selected: String) -> [String] {
        tabs.filter { $0 != selected }
    }
}
