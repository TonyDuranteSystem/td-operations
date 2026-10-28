import Foundation

/// PURE: how the Mac works through a page of CRM changes.
public enum ChangeBatch {
    /// Pages are small on purpose: Finder's position in the feed only moves when a page is finished, so with small pages a Mac that is
    /// stopped half way (macOS ends an idle Finder helper) keeps what it already did and carries on from there, not from the start.
    public static let pageSize = 100
    /// How many items are looked up at the same time (each lookup is one call to the CRM).
    public static let parallelLookups = 8

    /// One entry per item — the LAST word on it wins (every saved file leaves two feed rows; a file saved and then deleted is just a delete).
    /// Order of the survivors = order of their last appearance.
    public static func collapse(_ changes: [AppChange]) -> [AppChange] {
        var lastIndex: [String: Int] = [:]
        for (i, c) in changes.enumerated() { lastIndex["\(c.kind.rawValue):\(c.id)"] = i }
        return changes.enumerated().compactMap { lastIndex["\($0.element.kind.rawValue):\($0.element.id)"] == $0.offset ? $0.element : nil }
    }
}

/// PURE: pacing of the app's "tell me when something changes" question (2026-10-28).
public enum PushPlan {
    /// How long the CRM may keep one question open (it caps this itself, and can switch it off with 0).
    public static let waitSeconds = 20

    /// How long to rest before asking again.
    ///  - trouble (offline, server error): 5, 10, 20, 40, then 60 seconds;
    ///  - something changed: ask again at once;
    ///  - an EMPTY answer that came back almost at once means the CRM has the waiting switched off: ask only every 10 seconds, never in a tight loop.
    public static func pause(afterAnswerIn elapsed: TimeInterval, gotChanges: Bool, failures: Int) -> TimeInterval {
        if failures > 0 { return min(60, 5 * pow(2, Double(min(failures - 1, 4)))) }
        if gotChanges { return 0 }
        return elapsed < 3 ? 10 : 0
    }
}
