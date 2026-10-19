import Foundation

/// How a Finder item is named inside the app. The id is what Finder remembers — NEVER the file name (a rename, a Unicode
/// form difference or a move must not change which item it is).
///   root                       → "root"
///   a top section (Clients)    → "s:<key>"
///   group "Alabama"            → "g:<key>"
///   a storage's top folder     → "o:<ownerId>"
///   a folder                   → "d:<ownerId>:<folderId>"
///   a file                     → "f:<ownerId>:<fileId>"
///   a person listed in a company's "2. Contacts" → "l:<companyOwnerId>:<contactsFolderId>:<personOwnerId | c-contactId>"
///   anything INSIDE such a person's storage      → "v:<companyOwnerId>:<contactsFolderId>:<personKey>|<the item's own id>"
/// The same person's storage shows in two places (People, and every company they belong to), exactly as in the CRM; Finder needs ONE id per
/// place, so what sits under a person's entry carries that entry's prefix (`via`) and resolves to the same real folder / file.
public indirect enum ItemID: Equatable, Hashable {
    case root
    case section(String)
    case group(String)
    case owner(String)
    case folder(owner: String, folder: String)
    case file(owner: String, file: String)
    case link(company: String, folder: String, target: String)
    case via(link: String, inner: ItemID)

    public var raw: String {
        switch self {
        case .root: return "root"
        case .section(let k): return "s:\(k)"
        case .group(let k): return "g:\(k)"
        case .owner(let o): return "o:\(o)"
        case .folder(let o, let f): return "d:\(o):\(f)"
        case .file(let o, let f): return "f:\(o):\(f)"
        case .link(let c, let f, let t): return "l:\(c):\(f):\(t)"
        case .via(let link, let inner): return "v:\(link)|\(inner.raw)"
        }
    }

    /// the real storage item behind this id (the same folder / file whatever place it is shown in)
    public var underlying: ItemID {
        if case .via(_, let inner) = self { return inner.underlying }
        return self
    }

    /// the person's entry this item is shown under (nil = not inside a person's entry)
    public var viaLink: String? {
        if case .via(let link, _) = self { return link }
        return nil
    }

    /// `id` as it must be shown under the person's entry `link`
    public func shown(via link: String?) -> ItemID { link.map { .via(link: $0, inner: self) } ?? self }

    public init?(raw: String) {
        if raw == "root" { self = .root; return }
        // a group / section key may itself contain ":" (the CRM's state groups are "state:Florida"), so these are prefix + EVERYTHING after it
        if raw.hasPrefix("g:") { let key = String(raw.dropFirst(2)); if key.isEmpty { return nil }; self = .group(key); return }
        if raw.hasPrefix("s:") { let key = String(raw.dropFirst(2)); if key.isEmpty { return nil }; self = .section(key); return }
        if raw.hasPrefix("v:") {
            let rest = String(raw.dropFirst(2))
            guard let bar = rest.firstIndex(of: "|") else { return nil }
            let link = String(rest[..<bar]), innerRaw = String(rest[rest.index(after: bar)...])
            guard !link.isEmpty, let inner = ItemID(raw: innerRaw) else { return nil }
            self = .via(link: link, inner: inner); return
        }
        if raw.hasPrefix("l:") {
            let parts = raw.split(separator: ":", maxSplits: 3, omittingEmptySubsequences: false).map(String.init)
            guard parts.count == 4, !parts[1].isEmpty, !parts[2].isEmpty, !parts[3].isEmpty else { return nil }
            self = .link(company: parts[1], folder: parts[2], target: parts[3]); return
        }
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
