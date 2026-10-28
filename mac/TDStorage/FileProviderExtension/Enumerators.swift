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
    private let domain: NSFileProviderDomain?
    init(api: StorageAPI, catalog: Catalog, domain: NSFileProviderDomain? = nil) { self.api = api; self.catalog = catalog; self.domain = domain }

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
                let page = try await api.changes(since: raw == "start" || raw == "v1" ? nil : raw, limit: ChangeBatch.pageSize)
                let clock = UserDefaults.standard, key = "td-storage-last-full-refresh"
                let last = (clock.object(forKey: key) as? Date)
                Trace.log("workingSet.changes", ["resync": page.resync, "minutes": page.resyncMinutes ?? -1, "lastAgoSec": last.map { Int(Date().timeIntervalSince($0)) } ?? -1])
                // the CRM says "start over" -> Finder lists everything again. Otherwise every `resyncMinutes` the groups and the company / person
                // folders are re-read and reported as updated (a company / person RENAME has no change-feed row: this is how Finder learns it).
                var refreshed: [NSFileProviderItem] = []
                if page.resync { clock.set(Date(), forKey: key); observer.finishEnumeratingWithError(NSFileProviderError(.syncAnchorExpired)); return }
                if ResyncClock.due(last: last, minutes: page.resyncMinutes) {
                    clock.set(Date(), forKey: key)
                    // the top levels (Clients, its groups, the storages) are re-read: a company / person rename has no change-feed row
                    var queue: [ItemID] = [.root]
                    while let next = queue.first {
                        queue.removeFirst()
                        for it in (try? await catalog.children(of: next)) ?? [] {
                            refreshed.append(it)
                            if let cid = ItemID(raw: it.itemIdentifier.rawValue) { switch cid { case .section, .group: queue.append(cid); default: break } }
                        }
                    }
                }
                if last == nil { clock.set(Date(), forKey: key) }
                var updated: [NSFileProviderItem] = refreshed
                var deleted: [NSFileProviderItemIdentifier] = []
                // one lookup per ITEM (a saved file leaves two feed rows), several at the same time: a day's backlog used to take ~10 minutes
                let batch = ChangeBatch.collapse(page.changes)
                var results = [Outcome](repeating: .skip, count: batch.count)
                await withTaskGroup(of: (Int, Outcome).self) { group in
                    var next = min(ChangeBatch.parallelLookups, batch.count)
                    for i in 0..<next { group.addTask { (i, await self.resolve(batch[i])) } }
                    for await (i, outcome) in group {
                        results[i] = outcome
                        if next < batch.count { let j = next; next += 1; group.addTask { (j, await self.resolve(batch[j])) } }
                    }
                }
                for o in results {
                    switch o {
                    case .update(let item): updated.append(item)
                    case .delete(let id): deleted.append(id)
                    case .skip: break
                    }
                }
                if !updated.isEmpty { observer.didUpdate(updated) }
                if !deleted.isEmpty { observer.didDeleteItems(withIdentifiers: deleted) }
                let next = page.cursor ?? raw
                observer.finishEnumeratingChanges(upTo: NSFileProviderSyncAnchor(Data(next.utf8)), moreComing: page.hasMore)
            } catch { observer.finishEnumeratingWithError(fileProviderError(error)) }
        }
    }
    private enum Outcome { case update(NSFileProviderItem), delete(NSFileProviderItemIdentifier), skip }

    /// What one feed row means for Finder: an updated item, an item to drop, or nothing (the item is gone again, or cannot be read right now).
    private func resolve(_ c: AppChange) async -> Outcome {
        let id: ItemID?
        switch c.kind {
        case .file: id = c.ownerId.map { .file(owner: $0, file: c.id) }
        case .folder: id = c.ownerId.map { .folder(owner: $0, folder: c.id) }
        case .owner: id = .owner(c.id)
        }
        guard let id else { return .skip }
        if c.op == .delete { return .delete(FPItem.identifier(for: id)) }
        // a storage's top folder is not a Finder item: never create one, and clear one an earlier build made
        if case .folder(_, let fid) = id, await catalog.isTopFolder(folder: fid) { return .delete(FPItem.identifier(for: id)) }
        if let item = try? await catalog.item(for: id) { return .update(item) }
        return .skip
    }
}
