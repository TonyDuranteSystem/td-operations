import Foundation

/// How a Finder item is named inside the app. The id is what Finder remembers — NEVER the file name (a rename, a Unicode
/// form difference or a move must not change which item it is).
///   root                       → "root"
///   group "Alabama"            → "g:<key>"
///   a storage's top folder     → "o:<ownerId>"
///   a folder                   → "d:<ownerId>:<folderId>"
///   a file                     → "f:<ownerId>:<fileId>"
public enum ItemID: Equatable, Hashable {
    case root
    case group(String)
    case owner(String)
    case folder(owner: String, folder: String)
    case file(owner: String, file: String)

    public var raw: String {
        switch self {
        case .root: return "root"
        case .group(let k): return "g:\(k)"
        case .owner(let o): return "o:\(o)"
        case .folder(let o, let f): return "d:\(o):\(f)"
        case .file(let o, let f): return "f:\(o):\(f)"
        }
    }

    public init?(raw: String) {
        if raw == "root" { self = .root; return }
        let parts = raw.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 2, !parts[1].isEmpty else { return nil }
        switch (parts[0], parts.count) {
        case ("g", 2): self = .group(parts[1])
        case ("o", 2): self = .owner(parts[1])
        case ("d", 3) where !parts[2].isEmpty: self = .folder(owner: parts[1], folder: parts[2])
        case ("f", 3) where !parts[2].isEmpty: self = .file(owner: parts[1], file: parts[2])
        default: return nil
        }
    }
}
