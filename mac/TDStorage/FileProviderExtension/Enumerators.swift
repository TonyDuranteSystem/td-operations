import FileProvider

/// Lists one folder when Finder opens it.
final class ContainerEnumerator: NSObject, NSFileProviderEnumerator {
    private let container: ItemID
    private let catalog: Catalog
    init(container: ItemID, catalog: Catalog) { self.container = container; self.catalog = catalog }

    func invalidate() {}

    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        Task {
            do {
                let items = try await catalog.children(of: container)
                observer.didEnumerate(items)
                observer.finishEnumerating(upTo: nil)
            } catch { observer.finishEnumeratingWithError(fileProviderError(error)) }
        }
    }

    // Changes are reported by the working-set enumerator (the CRM change feed); a folder enumerator has none of its own.
    func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        observer.finishEnumeratingChanges(upTo: anchor, moreComing: false)
    }
    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) { completionHandler(NSFileProviderSyncAnchor(Data("v1".utf8))) }
}

/// Tells Finder what changed in the CRM (rename, move, trash, new file, a storage appearing or going). The anchor is the CRM's own
/// cursor. An anchor older than the kept log, or any trouble reading the feed, ends with `syncAnchorExpired` — Finder then lists
/// everything again from the top, which is always safe.
final class WorkingSetEnumerator: NSObject, NSFileProviderEnumerator {
    private let api: StorageAPI
    private let catalog: Catalog
    init(api: StorageAPI, catalog: Catalog) { self.api = api; self.catalog = catalog }

    func invalidate() {}
    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) { observer.finishEnumerating(upTo: nil) }

    /// Take the head BEFORE anything is listed: changes made while Finder is listing then arrive from this cursor.
    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        Task {
            let head = (try? await api.head()) ?? nil
            completionHandler(NSFileProviderSyncAnchor(Data((head ?? "start").utf8)))
        }
    }

    func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        Task {
            do {
                let raw = String(data: anchor.rawValue, encoding: .utf8) ?? "start"
                let page = try await api.changes(since: raw == "start" || raw == "v1" ? nil : raw)
                let clock = UserDefaults.standard, key = "td-storage-last-full-refresh"
                let last = (clock.object(forKey: key) as? Date)
                // a full refresh: when the CRM says so, or every `resyncMinutes` (a company / person RENAME has no change-feed row: this is how Finder learns it)
                if page.resync || ResyncClock.due(last: last, minutes: page.resyncMinutes) {
                    clock.set(Date(), forKey: key)
                    observer.finishEnumeratingWithError(NSFileProviderError(.syncAnchorExpired)); return
                }
                if last == nil { clock.set(Date(), forKey: key) }
                var updated: [NSFileProviderItem] = []
                var deleted: [NSFileProviderItemIdentifier] = []
                for c in page.changes {
                    let id: ItemID?
                    switch c.kind {
                    case .file: id = c.ownerId.map { .file(owner: $0, file: c.id) }
                    case .folder: id = c.ownerId.map { .folder(owner: $0, folder: c.id) }
                    case .owner: id = .owner(c.id)
                    }
                    guard let id else { continue }
                    if c.op == .delete { deleted.append(FPItem.identifier(for: id)); continue }
                    if let item = try? await catalog.item(for: id) { updated.append(item) }
                }
                if !updated.isEmpty { observer.didUpdate(updated) }
                if !deleted.isEmpty { observer.didDeleteItems(withIdentifiers: deleted) }
                let next = page.cursor ?? raw
                observer.finishEnumeratingChanges(upTo: NSFileProviderSyncAnchor(Data(next.utf8)), moreComing: page.hasMore)
            } catch { observer.finishEnumeratingWithError(fileProviderError(error)) }
        }
    }
}
