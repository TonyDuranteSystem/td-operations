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
