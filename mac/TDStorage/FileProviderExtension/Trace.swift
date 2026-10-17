import Foundation

/// A private trace of what macOS asks this extension to do when an app saves into TD Storage (phase P3 step C0, dev job 1992a087): which call,
/// which name, how big, which fields changed. DEBUG builds only — a release build compiles this to nothing. NEVER logs file contents, tokens,
/// upload addresses or request headers. File names may be private, so the log stays on this Mac in the extension's own folder and is capped at 1 MB.
enum Trace {
    #if DEBUG
    private static let queue = DispatchQueue(label: "td-storage-trace")
    static var logURL: URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return dir.appendingPathComponent("tds-trace.log")
    }
    static func log(_ call: String, _ fields: [String: Any] = [:]) {
        queue.async {
            var line: [String: Any] = ["t": ISO8601DateFormatter().string(from: Date()), "call": call]
            for (k, v) in fields { line[k] = v }
            guard let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]), var text = String(data: data, encoding: .utf8) else { return }
            text += "\n"
            let url = logURL
            if let a = try? FileManager.default.attributesOfItem(atPath: url.path), (a[.size] as? NSNumber)?.intValue ?? 0 > 1_000_000 { try? FileManager.default.removeItem(at: url) }
            if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(Data(text.utf8)); try? h.close() }
            else { try? text.write(to: url, atomically: true, encoding: .utf8) }
        }
    }
    #else
    static func log(_ call: String, _ fields: [String: Any] = [:]) {}
    #endif
}
