// TD Social — the iPhone app (dev job 2072bc3e, Step 3). A thin native shell: sign-in, a tab bar that follows what the SERVER says the person may see,
// one web view per tab showing the existing screens, real Apple alerts and the icon number.
import SwiftUI
import UserNotifications

@main
struct TDSocialApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel.shared
    var body: some Scene {
        // light only: every web screen is light (app mode switches dark mode off), so the app's own bars must not turn black on a dark phone
        WindowGroup { RootView().environmentObject(model).preferredColorScheme(.light) }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = DeviceBody.hex(deviceToken)
        Task { @MainActor in await AppModel.shared.registerDevice(token: token) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NSLog("[TDSocial] could not register for alerts: %@", error.localizedDescription)
    }

    // an alert arrives while the app is open: no banner (the person is looking at the app), but the numbers refresh
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        await AppModel.shared.check()
        return []
    }

    // the person tapped an alert
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let content = response.notification.request.content
        let url = content.userInfo["url"] as? String
        let thread = content.threadIdentifier
        await MainActor.run { AppModel.shared.openFromAlert(url: url, thread: thread.isEmpty ? nil : thread) }
    }
}
