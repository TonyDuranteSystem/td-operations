import Foundation

/// A file that is still being written must not be saved as the real file (a browser download, a big copy): the finished version would be
/// refused later because the name is taken. This waits until the file's size and modification time have not changed for `quiet` seconds.
public enum FileStability {
    public struct Snapshot: Equatable { public var size: Int; public var modified: Date? }

    public static func snapshot(of url: URL) -> Snapshot? {
        guard let a = try? FileManager.default.attributesOfItem(atPath: url.path) else { return nil }
        return Snapshot(size: (a[.size] as? NSNumber)?.intValue ?? 0, modified: a[.modificationDate] as? Date)
    }

    /// Returns the final snapshot. Throws when the file disappears or keeps changing for `max` seconds (the system then retries later).
    public static func waitUntilStable(_ url: URL, quiet: TimeInterval = 4, poll: TimeInterval = 1, max: TimeInterval = 600) async throws -> Snapshot {
        guard var last = snapshot(of: url) else { throw StorageAPIError.transport("The file is not there any more.") }
        var stableSince = Date()
        let started = Date()
        while true {
            if Date().timeIntervalSince(stableSince) >= quiet { return last }
            if Date().timeIntervalSince(started) > max { throw StorageAPIError.transport("The file is still being written.") }
            try await Task.sleep(nanoseconds: UInt64(poll * 1_000_000_000))
            guard let now = snapshot(of: url) else { throw StorageAPIError.transport("The file is not there any more.") }
            if now != last { last = now; stableSince = Date() }
        }
    }
}
