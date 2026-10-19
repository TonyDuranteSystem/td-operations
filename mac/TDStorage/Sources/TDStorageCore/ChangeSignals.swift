import Foundation

/// PURE: from a page of changes, which folders must Finder re-read? Item = a container id in `ItemID` form.
/// A move names BOTH the new and the old parent; an owner change refreshes the top of the tree (its group or label may have moved).
public enum ChangeSignals {
    public struct Result: Equatable {
        public var containers: Set<String> = []
        /// true when the top of the tree (groups / storages) must be re-read
        public var rootChanged = false
    }

    public static func affected(_ changes: [AppChange]) -> Result {
        var out = Result()
        for c in changes {
            switch c.kind {
            case .owner:
                out.rootChanged = true
                if let o = c.ownerId { out.containers.insert(ItemID.owner(o).raw) }
            case .folder, .file:
                guard let owner = c.ownerId else { continue }
                func container(_ parent: String?, _ ownerId: String) -> String {
                    guard let parent else { return ItemID.owner(ownerId).raw }
                    return ItemID.folder(owner: ownerId, folder: parent).raw
                }
                out.containers.insert(container(c.parentId, owner))
                if c.oldParentId != nil || c.oldOwnerId != nil {
                    out.containers.insert(container(c.oldParentId ?? c.parentId, c.oldOwnerId ?? owner))
                }
            }
        }
        return out
    }
}
