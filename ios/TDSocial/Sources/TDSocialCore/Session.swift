// What the server's answer to "who am I?" means for the app's first screen. Pure.
import Foundation

public enum SessionState: Equatable {
    case signedIn(AppMe)
    /// no valid sign-in (or the answer was a redirect to a login page): show the sign-in page
    case needsSignIn
    /// the server's TD Social switch is off
    case notSwitchedOn
    /// anything else (no connection, a server error)
    case failed(String)
}

public enum SessionCheck {
    public static func classify(status: Int, body: Data?) -> SessionState {
        switch status {
        case 200:
            if let body = body, let me = try? JSONDecoder().decode(AppMe.self, from: body), me.ok { return .signedIn(me) }
            // a 200 that is not our JSON is a login page the server sent instead of an answer
            return .needsSignIn
        case 401, 301, 302, 303, 307, 308:
            return .needsSignIn
        case 503:
            if let body = body, let text = String(data: body, encoding: .utf8), text.contains("APP_NOT_ENABLED") { return .notSwitchedOn }
            return .failed("The server is busy (503).")
        case 403:
            // a login the server turns away from TD Social (a client, a partner): the sign-in page is the honest place to be
            return .needsSignIn
        case -1:
            return .failed("No connection.")
        default:
            return .failed("The server answered \(status).")
        }
    }
}

public enum DeviceBody {
    /// the JSON the server expects when a phone registers (PUT /api/marketing/app/devices)
    public static func registration(token: String, bundleId: String, apnsEnv: String, deviceName: String, appVersion: String, appBuild: Int) -> [String: Any] {
        ["token": token, "bundleId": bundleId, "apnsEnv": apnsEnv, "deviceName": deviceName, "appVersion": appVersion, "appBuild": appBuild]
    }

    public static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
}
