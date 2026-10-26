import Foundation

/// Where a changed item sits in the tree FINDER knows. A storage's own top folder is not a Finder item: Finder shows its contents directly under the
/// storage (the Business / My files entry, or a company's / person's entry). The CRM, though, reports the top folder's id as the parent of everything
/// directly inside it. A change reported with that id as the parent names a folder Finder has never seen, so Finder ignored the item (a new folder
/// created in the CRM's Business top level never appeared — Antonio, 2026-10-26). This decides which of the two a server parent id is.
public enum ParentResolver {
    /// `serverParent`: the parent id the CRM reports (nil = the item IS the top folder). `topFolderId`: the id of the storage's top folder, when known.
    /// true = the item sits directly in the storage's top level (its Finder parent is the storage entry itself).
    public static func isTopLevel(serverParent: String?, topFolderId: String?) -> Bool {
        guard let p = serverParent else { return true }
        guard let top = topFolderId else { return false }
        return p.caseInsensitiveCompare(top) == .orderedSame
    }
}
