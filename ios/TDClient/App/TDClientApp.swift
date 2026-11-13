// The client iPhone app (MyLLC Manager 2.0), dev job 056a70d0, Step 5.
// A thin native shell: the portal's own pages in a web view that says it is the client app (browser name ends in `TDClient/`), a native bottom bar and Menu
// drawn from the server's own answer (/api/portal/app/me), and phone alerts (Apple token saved through /api/portal/app/devices).
import SwiftUI
import UserNotifications

@main
struct TDClientApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = ClientModel.shared
    var body: some Scene {
        WindowGroup { RootView().environmentObject(model) }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        // alerts are NOT asked about here (the person is asked once, after signing in: ClientModel.checkAlerts); a phone that already said yes just refreshes its token
        Task { @MainActor in await ClientModel.shared.checkAlertsAtLaunch() }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in await ClientModel.shared.didGetToken(hex) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        #if DEBUG
        Task { @MainActor in ClientModel.shared.status = "No alert token: \(error.localizedDescription)" }
        #endif
    }

    // an alert that arrives while the app is open is still shown as a banner
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        // the numbers on the bar (Chat, Documents ...) change with the alert, not only the next time the person moves
        await MainActor.run { ClientModel.shared.alertArrivedWhileOpen() }
        return [.banner, .list, .sound, .badge]
    }

    // tapping an alert opens the page the server named (a same-site path, checked again in `open`)
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let path = response.notification.request.content.userInfo["url"] as? String
        await MainActor.run { if let path { ClientModel.shared.open(path: path) } }
    }
}
