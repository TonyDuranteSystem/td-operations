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

    func children(of container: ItemID) async throws -> [FPItem] {
        switch container {
        case .root:
            let groups = try await api.navigation()
            let names = Disambiguator.unique(groups.map { (id: $0.key, name: NameMapper.finderName(fromServer: $0.label)) })
            return groups.map { FPItem(id: .group($0.key), parent: .root, filename: names[$0.key] ?? $0.label, isFolder: true) }
        case .group(let key):
            let groups = try await api.navigation()
            guard let g = groups.first(where: { $0.key == key }) else { return [] }
            let names = Disambiguator.unique(g.owners.map { (id: $0.id, name: NameMapper.finderName(fromServer: $0.label)) })
            return g.owners.map { FPItem(id: .owner($0.id), parent: .group(key), filename: names[$0.id] ?? $0.label, isFolder: true) }
        case .owner(let owner):
            return try await listing(owner: owner, folder: nil, parent: container)
        case .folder(let owner, let folder):
            return try await listing(owner: owner, folder: folder, parent: container)
        case .file:
            return []
        }
    }

    private func listing(owner: String, folder: String?, parent: ItemID) async throws -> [FPItem] {
        let l = try await api.folder(owner: owner, folder: folder)
        let entries = l.folders.map { (id: $0.id, name: NameMapper.finderName(fromServer: $0.name)) } + l.files.map { (id: $0.id, name: NameMapper.finderName(fromServer: $0.name)) }
        let names = Disambiguator.unique(entries)
        var out: [FPItem] = l.folders.map { FPItem(id: .folder(owner: owner, folder: $0.id), parent: parent, filename: names[$0.id] ?? $0.name, isFolder: true, canSave: $0.canSave ?? false) }
        out += l.files.map { fileItem($0, owner: owner, parent: parent, name: names[$0.id] ?? $0.name) }
        return out
    }

    // MARK: one item by id

    func item(for id: ItemID) async throws -> FPItem {
        switch id {
        case .root:
            return FPItem(id: .root, parent: .root, filename: "TD Storage", isFolder: true)
        case .group(let key):
            let groups = try await api.navigation()
            guard let g = groups.first(where: { $0.key == key }) else { throw StorageAPIError.notFound }
            return FPItem(id: id, parent: .root, filename: NameMapper.finderName(fromServer: g.label), isFolder: true)
        case .owner(let owner):
            let groups = try await api.navigation()
            for g in groups { if let o = g.owners.first(where: { $0.id == owner }) { return FPItem(id: id, parent: .group(g.key), filename: NameMapper.finderName(fromServer: o.label), isFolder: true) } }
            throw StorageAPIError.notFound
        case .folder(let owner, let folder):
            let it = try await api.item(kind: "folder", id: folder)
            return FPItem(id: id, parent: it.parentId.map { .folder(owner: owner, folder: $0) } ?? .owner(owner), filename: NameMapper.finderName(fromServer: it.name), isFolder: true, canSave: it.canSave ?? false)
        case .file(let owner, let file):
            let it = try await api.item(kind: "file", id: file)
            let parent: ItemID = it.parentId.map { .folder(owner: owner, folder: $0) } ?? .owner(owner)
            return FPItem(id: id, parent: parent, filename: NameMapper.finderName(fromServer: it.name), isFolder: false, size: it.size, modified: date(it.updatedAt), versionTag: "\(it.size ?? 0)-\(it.updatedAt ?? "")", canUpdate: it.mine ?? false)
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
