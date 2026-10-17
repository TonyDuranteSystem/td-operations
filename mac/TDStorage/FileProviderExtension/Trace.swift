import Foundation
import os

/// A private trace of what macOS asks this extension to do when an app saves into TD Storage (phase P3 step C0, dev job 1992a087): which call,
/// which name, how big, which fields changed. DEBUG builds only — a release build compiles this to nothing. NEVER logs file contents, tokens,
/// upload addresses or request headers. File names may be private, so this exists only in the test (Debug) build on a Mac that uses sandbox
/// test data; it goes to the system log of this Mac (read with: log show --last 10m --predicate 'subsystem == "com.tonydurante.tdstorage.trace"').
enum Trace {
    #if DEBUG
    private static let logger = Logger(subsystem: "com.tonydurante.tdstorage.trace", category: "extension")
    static func log(_ call: String, _ fields: [String: Any] = [:]) {
        var line: [String: Any] = ["call": call]
        for (k, v) in fields { line[k] = v }
        guard let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) else { return }
        logger.notice("\(text, privacy: .public)")
    }
    #else
    static func log(_ call: String, _ fields: [String: Any] = [:]) {}
    #endif
}
