import XCTest
@testable import TDSocialCore

// The You screen moves a switch at once (before the server confirms), using these pure helpers; the server's own answer replaces the result.
final class PrefsTests: XCTestCase {
    let prefs = AppPrefs(mutedTabs: ["marketing"], whatsapp: true, email: ["support": true, "antonio": false])

    func testMutingTabsAddsThemOnceAndKeepsTheRest() {
        let p = prefs.settingMute(["talk", "marketing"], true)
        XCTAssertEqual(p.mutedTabs, ["marketing", "talk"], "sorted, no duplicates")
        XCTAssertEqual(p.whatsapp, true)
        XCTAssertEqual(p.email, ["support": true, "antonio": false])
    }

    func testBringingTabsBackRemovesOnlyThose() {
        XCTAssertEqual(prefs.settingMute(["marketing"], false).mutedTabs, [])
        XCTAssertEqual(prefs.settingMute(["talk"], false).mutedTabs, ["marketing"], "a tab that was not muted changes nothing")
    }

    func testTheMasterSwitchMutesAndRestoresEveryTab() {
        let all = ["talk", "portal", "whatsapp", "inbox", "marketing"]
        XCTAssertEqual(AppPrefs().settingMute(all, true).mutedTabs, all.sorted())
        XCTAssertEqual(AppPrefs(mutedTabs: all).settingMute(all, false).mutedTabs, [])
    }

    func testWhichMessagesSwitchesChangeOneKeyOnly() {
        XCTAssertEqual(prefs.settingAlert("whatsapp", false).whatsapp, false)
        let e = prefs.settingAlert("email:antonio", true)
        XCTAssertEqual(e.email, ["support": true, "antonio": true])
        XCTAssertEqual(e.whatsapp, true)
        XCTAssertEqual(e.mutedTabs, ["marketing"])
    }

    func testASwitchTheLoginDoesNotHaveIsNeverInvented() {
        XCTAssertNil(AppPrefs().settingAlert("whatsapp", true).whatsapp, "no WhatsApp tab: no WhatsApp switch appears")
        XCTAssertNil(AppPrefs().settingAlert("email:support", true).email)
        XCTAssertEqual(prefs.settingAlert("something-else", true), prefs)
    }

    func testReplacingThePrefsKeepsTheRestOfTheAnswer() {
        let me = AppMe(user: AppUser(id: "u", email: nil, name: "A"), loginKind: "staff", tabs: [AppTabInfo(id: "talk", label: "TD Talk")], prefs: prefs, counts: ["talk": 2], badge: 2)
        let next = me.withPrefs(prefs.settingMute(["talk"], true))
        XCTAssertEqual(next.prefs.mutedTabs, ["marketing", "talk"])
        XCTAssertEqual(next.user, me.user)
        XCTAssertEqual(next.tabs, me.tabs)
        XCTAssertEqual(next.badge, 2)
        XCTAssertEqual(next.count(for: "talk"), 2)
    }
}
