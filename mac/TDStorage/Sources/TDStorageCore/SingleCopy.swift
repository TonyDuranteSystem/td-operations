import Foundation

/// ONE running copy of the app per Mac (dev job 1992a087, 2026-11-23: on the office Mac mini two extra copies of the same app, from the builds folder,
/// started by themselves next to the real one in Applications; the app refuses a normal Quit, so they simply stayed, and Finder then talks to whichever
/// copy answers — creates failed with "server unreachable").
///
/// Every copy of the app asks the same question at start and once a minute: "is another copy with my own app id running, and which of us stays?"
/// The answer is the same on every copy (a plain ranking), so exactly one stays and the others end themselves; the one that stays also ends the others
/// (a copy that cannot read this rule, an older build, is ended by the newer one). PURE: no process lookups here, so it is fully testable.
///
/// Ranking (first difference wins): 1) the copy in the Applications folder, 2) the higher build number (a newer version replaces an older one),
/// 3) the copy that has been running longer, 4) the lower process number (so two copies never both stay or both go).
public enum SingleCopy {
    public struct Copy: Equatable, Sendable {
        public let pid: Int32
        public let path: String
        public let build: Int
        /// seconds since the copy started (bigger = older); nil when unknown
        public let runningSeconds: Double?
        public init(pid: Int32, path: String, build: Int, runningSeconds: Double? = nil) {
            self.pid = pid; self.path = path; self.build = build; self.runningSeconds = runningSeconds
        }
        /// "/Applications/…" — the system-wide Applications folder. A copy in ~/Applications, Downloads, a builds folder … is NOT.
        public var inApplications: Bool { path.hasPrefix("/Applications/") }
    }

    /// true when `a` should stay in preference to `b`
    public static func outranks(_ a: Copy, _ b: Copy) -> Bool {
        if a.inApplications != b.inApplications { return a.inApplications }
        if a.build != b.build { return a.build > b.build }
        if let ra = a.runningSeconds, let rb = b.runningSeconds, ra != rb { return ra > rb }
        return a.pid < b.pid
    }

    /// What `me` must do given the OTHER running copies of the same app id.
    public enum Verdict: Equatable, Sendable {
        /// no better copy is running: keep running; `end` = the lower-ranked copies to end (empty when `me` is alone)
        case stay(end: [Int32])
        /// a better copy is running: end myself
        case yield(to: Int32)
    }

    public static func decide(me: Copy, others: [Copy]) -> Verdict {
        let rivals = others.filter { $0.pid != me.pid }
        if let best = rivals.filter({ outranks($0, me) }).min(by: { outranks($0, $1) }) { return .yield(to: best.pid) }
        return .stay(end: rivals.map { $0.pid }.sorted())
    }
}
