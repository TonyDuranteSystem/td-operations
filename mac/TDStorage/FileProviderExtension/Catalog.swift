import FileProvider
import UniformTypeIdentifiers

/// What Finder is told about each item. Files can be read. A NEW file can be added only into a folder the CRM says may take one
/// (`canSave`: Business and My files for now); nothing existing can be renamed, moved, replaced or deleted from Finder (the capabilities
/// below say so, so Finder never even offers it).
final class FPItem: NSObject, NSFileProviderItem {
    let itemIdentifier: NSFileProviderItemIdentifier
    let parentItemIdentifier: NSFileProviderItemIdentifier
    let filename: String
    let isFolder: Bool
    let size: Int?
    let modified: Date?
    let contentVersionTag: String
    /// may the Mac save a NEW file into this folder? The CRM decides (Business and My files only for now); never anything else is allowed.
    let canSave: Bool
    /// a file THIS Mac saved: macOS may send its changed content back and the CRM keeps it as a new version
    let canUpdate: Bool

    init(id: ItemID, parent: ItemID, filename: String, isFolder: Bool, size: Int? = nil, modified: Date? = nil, versionTag: String = "", canSave: Bool = false, canUpdate: Bool = false) {
        self.itemIdentifier = FPItem.identifier(for: id)
        self.parentItemIdentifier = FPItem.identifier(for: parent)
        self.filename = filename
        self.isFolder = isFolder
        self.size = size
        self.modified = modified
        self.contentVersionTag = versionTag
        self.canSave = canSave
        self.canUpdate = canUpdate
    }

    /// The same item with the modification date of the LOCAL file: when a Mac saves a file, the item handed back must carry the file's own date, or
    /// macOS rewrites the file's date and an app that saved it (TextEdit) says "the file has been changed by another application".
    func replacingModified(_ date: Date?) -> FPItem {
        guard let date, let id = FPItem.itemID(for: itemIdentifier), let parent = FPItem.itemID(for: parentItemIdentifier) else { return self }
        return FPItem(id: id, parent: parent, filename: filename, isFolder: isFolder, size: size, modified: date, versionTag: contentVersionTag, canSave: canSave, canUpdate: canUpdate)
    }

    /// the same item under another id / parent (the same person's storage shown under a company's "2. Contacts")
    func rewrapped(id: ItemID, parent: ItemID) -> FPItem {
        FPItem(id: id, parent: parent, filename: filename, isFolder: isFolder, size: size, modified: modified, versionTag: contentVersionTag, canSave: canSave, canUpdate: canUpdate)
    }

    static func identifier(for id: ItemID) -> NSFileProviderItemIdentifier { id == .root ? .rootContainer : NSFileProviderItemIdentifier(id.raw) }
    static func itemID(for identifier: NSFileProviderItemIdentifier) -> ItemID? { identifier == .rootContainer ? .root : ItemID(raw: identifier.rawValue) }

    var capabilities: NSFileProviderItemCapabilities {
        guard isFolder else { return canUpdate ? [.allowsReading, .allowsWriting] : [.allowsReading] }
        return canSave ? [.allowsReading, .allowsContentEnumerating, .allowsAddingSubItems] : [.allowsReading, .allowsContentEnumerating]
    }
    var contentType: UTType {
        if isFolder { return .folder }
        let ext = (filename as NSString).pathExtension
        return UTType(filenameExtension: ext) ?? .data
    }
    var documentSize: NSNumber? { size.map { NSNumber(value: $0) } }
    var contentModificationDate: Date? { modified }
    var creationDate: Date? { modified }
    var itemVersion: NSFileProviderItemVersion {
        NSFileProviderItemVersion(contentVersion: Data(contentVersionTag.utf8), metadataVersion: Data(filename.utf8))
    }
}

/// The tree as Finder sees it: root → groups → storages → the storage's own folders and files. Everything comes from the CRM
/// (`StorageAPI`); nothing is invented here and nothing is cached on disk by this class.
actor Catalog {
    let api: StorageAPI
    init(api: StorageAPI) { self.api = api }

    private let iso: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
    private let isoPlain = ISO8601DateFormatter()
    private func date(_ s: String?) -> Date? { s.flatMap { iso.date(from: $0) ?? isoPlain.date(from: $0) } }

    private func fileItem(_ f: FileRef, owner: String, parent: ItemID, name: String) -> FPItem {
        FPItem(id: .file(owner: owner, file: f.id), parent: parent, filename: name, isFolder: false, size: f.size, modified: date(f.updatedAt), versionTag: "\(f.size ?? 0)-\(f.updatedAt)", canUpdate: f.mine ?? false)
    }

    // MARK: listing a container
    //
    // THE SHAPE IS THE STORAGE PAGE'S (Antonio 2026-10-19: "it must show exactly how storage is"): Clients (states, One-time customers, People, Companies being
    // formed ...), Business and My files at the top; inside a company, 1. Company ... 2. Contacts (each person opens that person's own storage) ... 5. Correspondence.

    private static let sectionNames = ["clients": "Clients", "business": "Business", "private": "My files"]
    private func sections(_ groups: [NavGroup]) -> [String] { ["clients", "business", "private"].filter { s in groups.contains { $0.section == s } } }
    /// Business and My files are ONE storage each: the CRM opens them straight into their folders, so here they ARE the storage (no extra level)
    private func singleStorage(_ section: String, _ groups: [NavGroup]) -> NavOwner? {
        let gs = groups.filter { $0.section == section }
        return gs.count == 1 && gs[0].owners.count == 1 ? gs[0].owners[0] : nil
    }

    func children(of container: ItemID) async throws -> [FPItem] {
        switch container {
        case .root:
            let groups = try await api.navigation()
            var entries: [(key: String, id: ItemID, name: String)] = []
            for s in sections(groups) { entries.append((key: s, id: .section(s), name: Self.sectionNames[s] ?? s)) }
            let names = Disambiguator.unique(entries.map { (id: $0.key, name: $0.name) })
            return entries.reversed().map { FPItem(id: $0.id, parent: .root, filename: names[$0.key] ?? $0.name, isFolder: true) }   // reversed: see `forFinder`
        case .section(let key):
            let groups = try await api.navigation()
            // Business and My files are ONE storage each: the CRM opens them straight into their folders, so the section IS that storage
            if key != "clients", let o = singleStorage(key, groups) { return try await listing(owner: o.id, folder: nil, parent: container, via: nil) }
            let gs = groups.filter { $0.section == key }
            let names = Disambiguator.unique(gs.map { (id: $0.key, name: NameMapper.finderName(fromServer: $0.label)) })
            return gs.reversed().map { FPItem(id: .group($0.key), parent: .section(key), filename: names[$0.key] ?? $0.label, isFolder: true) }
        case .group(let key):
            let groups = try await api.navigation()
            guard let g = groups.first(where: { $0.key == key }) else { return [] }
            let names = Disambiguator.unique(g.owners.map { (id: $0.id, name: NameMapper.finderName(fromServer: $0.label)) })
            return g.owners.reversed().map { FPItem(id: .owner($0.id), parent: .group(key), filename: names[$0.id] ?? $0.label, isFolder: true) }
        case .owner(let owner):
            return try await listing(owner: owner, folder: nil, parent: container, via: nil)
        case .folder(let owner, let folder):
            return try await listing(owner: owner, folder: folder, parent: container, via: nil)
        case .link(let company, let folder, let target):
            if target.hasPrefix("c-") { return [] }          // a person with no storage of their own: listed, nothing to open
            return try await listing(owner: target, folder: nil, parent: container, via: "\(company):\(folder):\(target)")
        case .via(let link, let inner):
            switch inner {
            case .folder(let owner, let folder): return try await listing(owner: owner, folder: folder, parent: container, via: link)
            default: return []
            }
        case .file:
            return []
        }
    }

    private func listing(owner: String, folder: String?, parent: ItemID, via: String?) async throws -> [FPItem] {
        let l = try await api.folder(owner: owner, folder: folder)
        let people = l.people ?? []
        let entries = l.folders.map { (id: $0.id, name: NameMapper.finderName(fromServer: $0.name)) }
            + l.files.map { (id: $0.id, name: NameMapper.finderName(fromServer: $0.name)) }
            + people.map { (id: "p:" + $0.contactId, name: NameMapper.finderName(fromServer: $0.name)) }
        let names = Disambiguator.unique(entries)
        var out: [FPItem] = l.folders.map { FPItem(id: ItemID.folder(owner: owner, folder: $0.id).shown(via: via), parent: parent, filename: names[$0.id] ?? $0.name, isFolder: true, canSave: $0.canSave ?? false) }
        out += people.map { pp in
            let target = pp.ownerId ?? "c-\(pp.contactId)"
            return FPItem(id: .link(company: owner, folder: folder ?? "", target: target), parent: parent, filename: names["p:" + pp.contactId] ?? pp.name, isFolder: true)
        }
        out += l.files.map { f in
            let it = fileItem(f, owner: owner, parent: parent, name: names[f.id] ?? f.name)
            return via == nil ? it : it.rewrapped(id: ItemID.file(owner: owner, file: f.id).shown(via: via), parent: parent)
        }
        // THE ORDER (Antonio 2026-10-19: exactly as the Storage page). Finder lists these by the time each item was FIRST received, newest first (its own "Date Added",
        // measured live: always the exact reverse of what was handed over, whatever dates the items carry), so the list is handed over LAST item first.
        return out.reversed()
    }

    // MARK: one item by id

    /// where a storage's top folder sits: Business and My files are shown as their section, every other storage under its group
    private func topParent(of owner: String) async -> ItemID {
        guard let groups = try? await api.navigation() else { return .owner(owner) }
        for g in groups where g.owners.contains(where: { $0.id == owner }) {
            if g.section != "clients", singleStorage(g.section, groups) != nil { return .section(g.section) }
        }
        return .owner(owner)
    }

    func item(for id: ItemID) async throws -> FPItem {
        switch id {
        case .root:
            return FPItem(id: .root, parent: .root, filename: "TD Storage", isFolder: true)
        case .section(let key):
            return FPItem(id: id, parent: .root, filename: Self.sectionNames[key] ?? key, isFolder: true)
        case .group(let key):
            let groups = try await api.navigation()
            guard let g = groups.first(where: { $0.key == key }) else { throw StorageAPIError.notFound }
            return FPItem(id: id, parent: .section(g.section), filename: NameMapper.finderName(fromServer: g.label), isFolder: true)
        case .owner(let owner):
            let groups = try await api.navigation()
            for g in groups {
                if let o = g.owners.first(where: { $0.id == owner }) {
                    if g.section != "clients", singleStorage(g.section, groups) != nil { throw StorageAPIError.notFound }   // shown as its section
                    return FPItem(id: id, parent: .group(g.key), filename: NameMapper.finderName(fromServer: o.label), isFolder: true)
                }
            }
            throw StorageAPIError.notFound
        case .folder(let owner, let folder):
            let it = try await api.item(kind: "folder", id: folder)
            let top = await topParent(of: owner)
            return FPItem(id: id, parent: it.parentId.map { .folder(owner: owner, folder: $0) } ?? top, filename: NameMapper.finderName(fromServer: it.name), isFolder: true, canSave: it.canSave ?? false)
        case .file(let owner, let file):
            let it = try await api.item(kind: "file", id: file)
            let top = await topParent(of: owner)
            let parent: ItemID = it.parentId.map { .folder(owner: owner, folder: $0) } ?? top
            return FPItem(id: id, parent: parent, filename: NameMapper.finderName(fromServer: it.name), isFolder: false, size: it.size, modified: date(it.updatedAt), versionTag: "\(it.size ?? 0)-\(it.updatedAt ?? "")", canUpdate: it.mine ?? false)
        case .link(let company, let folder, let target):
            let l = try await api.folder(owner: company, folder: folder)
            guard let pp = (l.people ?? []).first(where: { ($0.ownerId ?? "c-\($0.contactId)") == target }) else { throw StorageAPIError.notFound }
            return FPItem(id: id, parent: .folder(owner: company, folder: folder), filename: NameMapper.finderName(fromServer: pp.name), isFolder: true)
        case .via(let link, let inner):
            let base = try await item(for: inner)
            guard let linkID = ItemID(raw: "l:" + link) else { throw StorageAPIError.notFound }
            let baseParent = FPItem.itemID(for: base.parentItemIdentifier)
            // the top folder of the person's storage is the person's entry itself; everything deeper keeps the same prefix
            let parent: ItemID
            if case .owner? = baseParent { parent = linkID } else { parent = (baseParent ?? .root).shown(via: link) }
            return base.rewrapped(id: id, parent: parent)
        }
    }
}

/// Errors in the words Finder understands. A wrong or missing sign-in is "not authenticated" (Finder shows its sign-in prompt);
/// a Mac that the CRM signed out (or that was offline for 24 hours) is the same, and the host app removes the TD Storage location when it sees it.
func fileProviderError(_ error: Error) -> Error {
    func described(_ domainError: NSError, _ message: String) -> NSError {
        NSError(domain: domainError.domain, code: domainError.code, userInfo: [NSLocalizedDescriptionKey: message])
    }
    switch error as? StorageAPIError {
    case .notSignedIn?, .deviceRevoked?, .leaseExpired?: return NSFileProviderError(.notAuthenticated)
    case .notFound?: return NSFileProviderError(.noSuchItem)
    case .forbidden?: return NSFileProviderError(.cannotSynchronize)
    // a sensitive document: said plainly, and NOT retried (a read-permission error is final)
    case .openInCRM(let message)?: return NSError(domain: NSCocoaErrorDomain, code: NSFileReadNoPermissionError, userInfo: [NSLocalizedDescriptionKey: message])
    // a SAVE the CRM said no to (name taken, wrong folder, too big …): said plainly, and NOT retried (a write-permission error is final)
    case .refused(let message)?: return NSError(domain: NSCocoaErrorDomain, code: NSFileWriteNoPermissionError, userInfo: [NSLocalizedDescriptionKey: message])
    case .rateLimited(let message)?: return described(NSFileProviderError(.serverUnreachable) as NSError, message)
    case .integrity(let message)?: return described(NSFileProviderError(.cannotSynchronize) as NSError, message)
    default: return NSFileProviderError(.serverUnreachable)
    }
}
