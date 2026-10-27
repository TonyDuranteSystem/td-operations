import Foundation

/// The "always running" rule (dev job 1992a087, Antonio 2026-10-27: a new version must reach a Mac in the middle of the day without anybody opening or
/// restarting anything). The app starts by itself at login; this decides what to do when something asks it to quit. Only a PERSON choosing Quit
/// (Cmd+Q, Dock > Quit) is refused — the app just hides and keeps running. The system shutting down / restarting / logging out, an update installing
/// itself, and "Quit all" are always allowed, so the Mac can never be stopped from restarting by this app.
public enum KeepAlive {
    /// the Apple-event quit reasons that come from the system (the 'why?' attribute of the quit event): shut down, restart, log out (really / plain), quit all
    public static let systemQuitReasons: Set<UInt32> = [fourCC("shut"), fourCC("rest"), fourCC("rlgo"), fourCC("logo"), fourCC("quia")]

    /// how long quitting stays allowed after an update starts installing or the system announces a power-off (seconds)
    public static let allowSeconds: TimeInterval = 60

    public static func fourCC(_ s: String) -> UInt32 { s.utf8.reduce(0) { ($0 << 8) | UInt32($1) } }

    /// PURE: should the app refuse this quit request (hide and keep running)?
    /// - `reason`: the quit reason code the system attached, nil when a person chose Quit
    /// - `allowed`: set by the app itself when it WANTS to quit (an update is installing) or the system announced a power-off / logout
    public static func shouldStay(reason: UInt32?, allowed: Bool) -> Bool {
        if allowed { return false }
        if let reason, systemQuitReasons.contains(reason) { return false }
        return true
    }
}
