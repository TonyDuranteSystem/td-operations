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
        if containerItemIdentifier == .workingSet { return WorkingSetEnumerator(api: api, catalog: catalog, domain: domain) }
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
                guard case .file(_, let fileId)? = FPItem.itemID(for: itemIdentifier)?.underlying else { throw StorageAPIError.notFound }
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
                let isFolderItem = itemTemplate.contentType == .folder || itemTemplate.contentType?.conforms(to: .folder) == true
                Trace.log("createItem.start", ["name": name, "parent": itemTemplate.parentItemIdentifier.rawValue, "templateId": itemTemplate.itemIdentifier.rawValue,
                    "folder": isFolderItem, "hasContents": url != nil, "fields": fields.rawValue, "options": options.rawValue,
                    "size": url.flatMap { FileStability.snapshot(of: $0)?.size } ?? -1, "junk": NameMapper.isJunk(name)])
                // system junk and partial downloads are never uploaded: the system is told this one is not synced
                if NameMapper.isJunk(name) { Trace.log("createItem.excluded", ["name": name]); throw NSFileProviderError(.excludedFromSync) }
                guard !isFolderItem else { Trace.log("createItem.refused", ["name": name, "why": "folder"]); throw noPermission("Folders can be created in the CRM, not from the Mac yet.") }
                let parentID = FPItem.itemID(for: itemTemplate.parentItemIdentifier)   // under a person listed in a company's "2. Contacts" the new item keeps that place
                guard case .folder(let owner, let folder)? = parentID?.underlying else { Trace.log("createItem.refused", ["name": name, "why": "no folder"]); throw noPermission("Open one of the folders first — files go inside a folder.") }
                // a file that is still being written is waited for (a browser download, a big copy): never saved half-finished
                var size = 0
                var modified = itemTemplate.contentModificationDate ?? nil
                if let url {
                    let snap = try await FileStability.waitUntilStable(url)
                    size = snap.size; modified = snap.modified ?? modified
                    Trace.log("createItem.stable", ["name": name, "size": size])
                }
                // the system's own id for this pending item is stable across Finder's retries and new for every new create; use it when it is not one of ours
                let sys = itemTemplate.itemIdentifier.rawValue
                let systemId = (FPItem.itemID(for: itemTemplate.itemIdentifier) == nil && itemTemplate.itemIdentifier != .rootContainer) ? sys : nil
                let key = ItemKey.make(parent: itemTemplate.parentItemIdentifier.rawValue, name: name, size: size, modified: modified, systemId: systemId)
                let mime = itemTemplate.contentType?.preferredMIMEType
                let slot = try await api.uploadSlot(ownerId: owner, folderId: folder, name: name, size: size, mimeType: mime, itemKey: key)
                var fileId = slot.alreadySaved == true ? slot.fileId : nil
                if fileId == nil {
                    guard let intent = slot.intentId else { throw StorageAPIError.badResponse }
                    // the bytes may already be in the CRM (a lost answer, or a big file the CRM is still registering): then only the save is asked again
                    if slot.alreadyUploaded != true {
                    guard let address = slot.uploadUrl else { throw StorageAPIError.badResponse }
                    var source = url
                    var emptyTemp: URL?
                    if source == nil { let t = FileManager.default.temporaryDirectory.appendingPathComponent("tds-empty-" + UUID().uuidString); FileManager.default.createFile(atPath: t.path, contents: Data()); source = t; emptyTemp = t }
                    defer { if let emptyTemp { try? FileManager.default.removeItem(at: emptyTemp) } }
                    try await uploader.upload(file: source!, to: address, mimeType: mime)
                    // it must not have changed while it was uploading (then the system asks again and the new content is saved)
                    if let before = url.flatMap({ FileStability.snapshot(of: $0) }), before.size != size { Trace.log("createItem.changedDuringUpload", ["name": name, "was": size, "now": before.size]); throw StorageAPIError.transport("The file changed while it was being saved.") }
                    }
                    // a big file is registered by the CRM in the background: wait for it (the call answers "pending" until the file exists)
                    fileId = try await api.saveWaiting(intentId: intent, itemKey: key).fileId
                }
                let id = ItemID.file(owner: owner, file: fileId!).shown(via: parentID?.viaLink)
                let item = try await catalog.item(for: id).replacingModified(modified)
                ledger.record(id: item.itemIdentifier.rawValue, keepSeconds: 900)   // the Mac's own copy is only kept briefly: the CRM has the file now
                Trace.log("createItem.saved", ["name": name, "size": size, "fileId": fileId ?? ""])
                completionHandler(item, [], false, nil)
            } catch { Trace.log("createItem.error", ["error": String(describing: error)]); completionHandler(nil, [], false, fileProviderError(error)) }
        }
        return progress
    }

    func modifyItem(_ item: NSFileProviderItem, baseVersion version: NSFileProviderItemVersion, changedFields: NSFileProviderItemFields, contents newContents: URL?, options: NSFileProviderModifyItemOptions = [], request: NSFileProviderRequest, completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        let progress = Progress(totalUnitCount: 1)
        Task {
            defer { progress.completedUnitCount = 1 }
            Trace.log("modifyItem", ["id": item.itemIdentifier.rawValue, "name": item.filename, "parent": item.parentItemIdentifier.rawValue, "fields": changedFields.rawValue, "hasContents": newContents != nil, "size": newContents.flatMap { FileStability.snapshot(of: $0)?.size } ?? -1])
            // harmless bookkeeping (dates, tags, extended attributes) is accepted and ignored; a change of NAME or PLACE is always refused
            guard let id = FPItem.itemID(for: item.itemIdentifier) else { completionHandler(nil, [], false, noPermission(Self.changeInCRM)); return }
            guard changedFields.intersection([.filename, .parentItemIdentifier]).isEmpty else { completionHandler(nil, [], false, noPermission(Self.changeInCRM)); return }
            do {
                // changed CONTENT: allowed only for a file THIS Mac saved (the CRM checks again) — it becomes a new version of that file
                if changedFields.contains(.contents), let newContents {
                    guard case .file(let owner, let fileId) = id.underlying else { throw noPermission(Self.changeInCRM) }
                    let info = try await api.item(kind: "file", id: fileId)
                    guard info.mine == true else { Trace.log("modifyItem.refused", ["id": fileId, "why": "not mine"]); throw noPermission(Self.changeInCRM) }
                    let snap = try await FileStability.waitUntilStable(newContents)
                    let key = ItemKey.make(parent: fileId, name: "update", size: snap.size, modified: snap.modified)
                    let mime = item.contentType?.preferredMIMEType
                    let slot = try await api.uploadSlot(ownerId: owner, folderId: info.parentId ?? "", name: info.name, size: snap.size, mimeType: mime, itemKey: key, replaceFileId: fileId)
                    guard let intent = slot.intentId, let address = slot.uploadUrl else { throw StorageAPIError.badResponse }
                    try await uploader.upload(file: newContents, to: address, mimeType: mime)
                    _ = try await api.save(intentId: intent, itemKey: key, replaceFileId: fileId)
                    let updated = try await catalog.item(for: id).replacingModified(snap.modified)
                    ledger.record(id: updated.itemIdentifier.rawValue, keepSeconds: 900)
                    Trace.log("modifyItem.updated", ["id": fileId, "size": snap.size])
                    completionHandler(updated, [], false, nil)
                    return
                }
                completionHandler(try await catalog.item(for: id), [], false, nil)
            } catch { Trace.log("modifyItem.error", ["error": String(describing: error)]); completionHandler(nil, [], false, fileProviderError(error)) }
        }
        return progress
    }

    func deleteItem(identifier: NSFileProviderItemIdentifier, baseVersion version: NSFileProviderItemVersion, options: NSFileProviderDeleteItemOptions = [], request: NSFileProviderRequest, completionHandler: @escaping (Error?) -> Void) -> Progress {
        Trace.log("deleteItem", ["id": identifier.rawValue])
        completionHandler(noPermission(Self.changeInCRM))
        return Progress()
    }
}
