import FileProvider
import Foundation

/// The Finder side of TD Storage (dev job 1992a087, phase P0). Read-only listing of the CRM storage; no downloads yet (phase P1),
/// no writes from Finder (phase P3 and later). Tokens come from the Keychain group shared with the host app.
final class FileProviderExtension: NSObject, NSFileProviderReplicatedExtension {
    let domain: NSFileProviderDomain
    let api: StorageAPI
    let catalog: Catalog
    let downloader: FileDownloader
    private var poller: Timer?
    private let ledger = EvictionLedger()
    let uploader = FileUploader()

    required init(domain: NSFileProviderDomain) {
        self.domain = domain
        let info = Bundle.main.infoDictionary ?? [:]
        let base = URL(string: info["TDServerURL"] as? String ?? "https://invalid.example")!
        let store = KeychainTokenStore(service: info["TDKeychainService"] as? String ?? "td-storage", accessGroup: info["TDKeychainGroup"] as? String)
        let lease = KeychainLeaseStore(service: info["TDKeychainService"] as? String ?? "td-storage", accessGroup: info["TDKeychainGroup"] as? String)
        self.api = StorageAPI(baseURL: base, store: store, lease: lease)
        self.catalog = Catalog(api: api)
        self.downloader = FileDownloader(api: api)
        super.init()
        Self.sweepTemporaryDownloads()
        evictDueCopies()
        // ask the system to look at the change feed every 30 seconds (it then calls the working-set enumerator below)
        DispatchQueue.main.async { [weak self] in
            self?.poller = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
                guard let self, let m = NSFileProviderManager(for: self.domain) else { return }
                m.signalEnumerator(for: .workingSet) { _ in }
                self.evictDueCopies()
            }
        }
    }

    /// The Mac keeps the copy of an opened file only briefly (the CRM says how long: 2 minutes for passports / IDs / ITIN papers, 15 for the
    /// rest). When the time is up the copy is removed; the file stays in Finder and downloads again the next time it is opened.
    func evictDueCopies() {
        guard let manager = NSFileProviderManager(for: domain) else { return }
        for id in ledger.due() {
            manager.evictItem(identifier: NSFileProviderItemIdentifier(id)) { [ledger] error in
                // gone, or never there: stop tracking. Any other error (the file is open right now): try again at the next sweep.
                if error == nil || (error as NSError?)?.code == NSFileProviderError.noSuchItem.rawValue { ledger.remove(id: id) }
            }
        }
    }

    func invalidate() { poller?.invalidate() }

    /// Downloads are written to a temporary file first; anything a crash left behind from an earlier run is removed whenever the extension starts.
    static func sweepTemporaryDownloads() {
        let dir = FileManager.default.temporaryDirectory
        for name in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [] where name.hasPrefix("tds-") {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
        }
    }

    func enumerator(for containerItemIdentifier: NSFileProviderItemIdentifier, request: NSFileProviderRequest) throws -> NSFileProviderEnumerator {
        if containerItemIdentifier == .workingSet { return WorkingSetEnumerator(api: api, catalog: catalog) }
        guard let id = FPItem.itemID(for: containerItemIdentifier) else { throw NSFileProviderError(.noSuchItem) }
        return ContainerEnumerator(container: id, catalog: catalog)
    }

    func item(for identifier: NSFileProviderItemIdentifier, request: NSFileProviderRequest, completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        Task {
            do {
                guard let id = FPItem.itemID(for: identifier) else { throw StorageAPIError.notFound }
                completionHandler(try await catalog.item(for: id), nil)
            } catch { completionHandler(nil, fileProviderError(error)) }
            progress.completedUnitCount = 1
        }
        return progress
    }

    // Reading a file (phase P1): the CRM gives a 60-second link; the file is downloaded, checked (size + SHA-256) and handed to the system.
    // Every file opens (passports, IDs and ITIN papers too, since 2026-10-17). The CRM says how long the Mac may keep the copy; it is removed then.
    func fetchContents(for itemIdentifier: NSFileProviderItemIdentifier, version requestedVersion: NSFileProviderItemVersion?, request: NSFileProviderRequest, completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        Task {
            do {
                guard case .file(_, let fileId)? = FPItem.itemID(for: itemIdentifier) else { throw StorageAPIError.notFound }
                let (url, info) = try await downloader.download(fileId: fileId)
                do {
                    let item = try await catalog.item(for: FPItem.itemID(for: itemIdentifier)!)
                    ledger.record(id: itemIdentifier.rawValue, keepSeconds: info.keepSeconds)
                    completionHandler(url, item, nil)
                } catch {
                    try? FileManager.default.removeItem(at: url)      // never leave a downloaded file behind when the hand-over fails
                    throw error
                }
            } catch { completionHandler(nil, nil, fileProviderError(error)) }
            progress.completedUnitCount = 1
        }
        return progress
    }

    // SAVING a NEW file (phase P3 step A). Only into a folder the CRM says may take one (canSave: Business and My files for now). The CRM
    // checks everything again. Real folders cannot be created from Finder yet; system junk and partial downloads are left out; nothing that
    // already exists can be changed, replaced, moved or deleted from here ("Open it in the CRM to change it").
    private static let changeInCRM = "This can only be changed in the CRM."
    private func noPermission(_ message: String) -> Error { NSError(domain: NSCocoaErrorDomain, code: NSFileWriteNoPermissionError, userInfo: [NSLocalizedDescriptionKey: message]) }

    func createItem(basedOn itemTemplate: NSFileProviderItem, fields: NSFileProviderItemFields, contents url: URL?, options: NSFileProviderCreateItemOptions = [], request: NSFileProviderRequest, completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        Task {
            defer { progress.completedUnitCount = 1 }
            do {
                let name = NameMapper.serverName(fromFinder: itemTemplate.filename)
                // system junk and partial downloads are never uploaded: the system is told this one is not synced
                if NameMapper.isJunk(name) { throw NSFileProviderError(.excludedFromSync) }
                guard itemTemplate.contentType != .folder, itemTemplate.contentType?.conforms(to: .folder) != true else { throw noPermission("Folders can be created in the CRM, not from the Mac yet.") }
                guard case .folder(let owner, let folder)? = FPItem.itemID(for: itemTemplate.parentItemIdentifier) else { throw noPermission("Open one of the folders first — files go inside a folder.") }
                let attrs = url.flatMap { try? FileManager.default.attributesOfItem(atPath: $0.path) }
                let size = (attrs?[.size] as? NSNumber)?.intValue ?? 0
                let modified = (attrs?[.modificationDate] as? Date) ?? itemTemplate.contentModificationDate ?? nil
                let key = ItemKey.make(parent: itemTemplate.parentItemIdentifier.rawValue, name: name, size: size, modified: modified)
                let mime = itemTemplate.contentType?.preferredMIMEType
                let slot = try await api.uploadSlot(ownerId: owner, folderId: folder, name: name, size: size, mimeType: mime, itemKey: key)
                var fileId = slot.alreadySaved == true ? slot.fileId : nil
                if fileId == nil {
                    guard let intent = slot.intentId, let address = slot.uploadUrl else { throw StorageAPIError.badResponse }
                    var source = url
                    var emptyTemp: URL?
                    if source == nil { let t = FileManager.default.temporaryDirectory.appendingPathComponent("tds-empty-" + UUID().uuidString); FileManager.default.createFile(atPath: t.path, contents: Data()); source = t; emptyTemp = t }
                    defer { if let emptyTemp { try? FileManager.default.removeItem(at: emptyTemp) } }
                    try await uploader.upload(file: source!, to: address, mimeType: mime)
                    fileId = try await api.save(intentId: intent, itemKey: key).fileId
                }
                let id = ItemID.file(owner: owner, file: fileId!)
                let item = try await catalog.item(for: id)
                ledger.record(id: item.itemIdentifier.rawValue, keepSeconds: 900)   // the Mac's own copy is only kept briefly: the CRM has the file now
                completionHandler(item, [], false, nil)
            } catch { completionHandler(nil, [], false, fileProviderError(error)) }
        }
        return progress
    }

    func modifyItem(_ item: NSFileProviderItem, baseVersion version: NSFileProviderItemVersion, changedFields: NSFileProviderItemFields, contents newContents: URL?, options: NSFileProviderModifyItemOptions = [], request: NSFileProviderRequest, completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        Task {
            defer { progress.completedUnitCount = 1 }
            // harmless bookkeeping (dates, tags, extended attributes) is accepted and ignored; any change to the name, place or content is refused
            let real: NSFileProviderItemFields = [.contents, .filename, .parentItemIdentifier]
            guard changedFields.intersection(real).isEmpty, let id = FPItem.itemID(for: item.itemIdentifier) else {
                completionHandler(nil, [], false, noPermission(Self.changeInCRM)); return
            }
            do { completionHandler(try await catalog.item(for: id), [], false, nil) } catch { completionHandler(nil, [], false, fileProviderError(error)) }
        }
        return progress
    }

    func deleteItem(identifier: NSFileProviderItemIdentifier, baseVersion version: NSFileProviderItemVersion, options: NSFileProviderDeleteItemOptions = [], request: NSFileProviderRequest, completionHandler: @escaping (Error?) -> Void) -> Progress {
        completionHandler(noPermission(Self.changeInCRM))
        return Progress()
    }
}
