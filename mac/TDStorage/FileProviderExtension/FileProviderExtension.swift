import FileProvider
import Foundation

/// The Finder side of TD Storage (dev job 1992a087, phase P0). Read-only listing of the CRM storage; no downloads yet (phase P1),
/// no writes from Finder (phase P3 and later). Tokens come from the Keychain group shared with the host app.
final class FileProviderExtension: NSObject, NSFileProviderReplicatedExtension {
    let domain: NSFileProviderDomain
    let api: StorageAPI
    let catalog: Catalog
    private var poller: Timer?

    required init(domain: NSFileProviderDomain) {
        self.domain = domain
        let info = Bundle.main.infoDictionary ?? [:]
        let base = URL(string: info["TDServerURL"] as? String ?? "https://invalid.example")!
        let store = KeychainTokenStore(service: info["TDKeychainService"] as? String ?? "td-storage", accessGroup: info["TDKeychainGroup"] as? String)
        self.api = StorageAPI(baseURL: base, store: store)
        self.catalog = Catalog(api: api)
        super.init()
        // ask the system to look at the change feed every 30 seconds (it then calls the working-set enumerator below)
        DispatchQueue.main.async { [weak self] in
            self?.poller = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
                guard let self, let m = NSFileProviderManager(for: self.domain) else { return }
                m.signalEnumerator(for: .workingSet) { _ in }
            }
        }
    }

    func invalidate() { poller?.invalidate() }

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

    // Reading a file's bytes comes in phase P1 (signed download link; sensitive documents are refused by the server).
    func fetchContents(for itemIdentifier: NSFileProviderItemIdentifier, version requestedVersion: NSFileProviderItemVersion?, request: NSFileProviderRequest, completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void) -> Progress {
        completionHandler(nil, nil, CocoaError(.featureUnsupported))
        return Progress()
    }

    // Read-only: the capabilities already stop Finder from offering these; if the system asks anyway, the answer is a plain "no".
    func createItem(basedOn itemTemplate: NSFileProviderItem, fields: NSFileProviderItemFields, contents url: URL?, options: NSFileProviderCreateItemOptions = [], request: NSFileProviderRequest, completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        completionHandler(nil, [], false, CocoaError(.fileWriteNoPermission))
        return Progress()
    }

    func modifyItem(_ item: NSFileProviderItem, baseVersion version: NSFileProviderItemVersion, changedFields: NSFileProviderItemFields, contents newContents: URL?, options: NSFileProviderModifyItemOptions = [], request: NSFileProviderRequest, completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void) -> Progress {
        completionHandler(nil, [], false, CocoaError(.fileWriteNoPermission))
        return Progress()
    }

    func deleteItem(identifier: NSFileProviderItemIdentifier, baseVersion version: NSFileProviderItemVersion, options: NSFileProviderDeleteItemOptions = [], request: NSFileProviderRequest, completionHandler: @escaping (Error?) -> Void) -> Progress {
        completionHandler(CocoaError(.fileWriteNoPermission))
        return Progress()
    }
}
