// Settings that differ per build flavour (Debug / Sandbox / Production). They come from Info.plist, which the project generator fills in from the
// flavour: the server address, the Apple alert environment and a short name for the server. Nothing here is a secret.
import Foundation

enum AppConfig {
    static var serverURL: URL { URL(string: info("TDServerURL")) ?? URL(string: "https://crm.tonydurante.us")! }
    static var serverHost: String { serverURL.host ?? "" }
    /// "development" for builds run from Xcode, "production" for TestFlight / App Store builds
    static var apnsEnv: String { info("TDApnsEnv") }
    static var serverName: String { info("TDServerName") }
    static var bundleId: String { Bundle.main.bundleIdentifier ?? "" }
    static var version: String { info("CFBundleShortVersionString") }
    static var build: Int { Int(info("CFBundleVersion")) ?? 0 }
    static var italian: Bool { Strings.isItalian(Locale.preferredLanguages) }
    static func say(_ m: Msg) -> String { Strings.text(m, italian: italian) }

    private static func info(_ key: String) -> String { (Bundle.main.object(forInfoDictionaryKey: key) as? String) ?? "" }
}
