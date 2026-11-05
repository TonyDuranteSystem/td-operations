// Opens a file (a PDF, a picture, an office document) from a page in the phone's own viewer, on top of the app, with Done and Share.
// Before this, an email attachment replaced the whole page with a bare PDF and nothing on screen led back.
// The download goes through the web view itself (WKDownload), so it uses the same sign-in as the page that offered the file.
import SwiftUI
import WebKit
import QuickLook

@MainActor
final class FileOpener: NSObject, WKDownloadDelegate, QLPreviewControllerDataSource, @MainActor QLPreviewControllerDelegate {
    static let shared = FileOpener()

    private var destinations: [ObjectIdentifier: URL] = [:]
    private var showing: URL?

    /// Take over a download the web view started (a PDF link, an attachment, a link marked "download").
    func adopt(_ download: WKDownload) { download.delegate = self }

    // MARK: WKDownloadDelegate

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("td-file-" + UUID().uuidString, isDirectory: true)
        do { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) } catch { completionHandler(nil); return }
        let url = folder.appendingPathComponent(FileRules.safeName(suggestedFilename, mimeType: response.mimeType))
        destinations[ObjectIdentifier(download)] = url
        completionHandler(url)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = destinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
        present(url)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let url = destinations.removeValue(forKey: ObjectIdentifier(download)) { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        if (error as NSError).code == NSURLErrorCancelled { return }
        let alert = UIAlertController(title: nil, message: AppConfig.say(.fileNotOpened), preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: AppConfig.say(.ok), style: .default))
        Self.topController()?.present(alert, animated: true)
    }

    // MARK: the viewer (Quick Look: Done on the left, Share on the right, pinch to zoom)

    private func present(_ url: URL) {
        guard let top = Self.topController() else { return }
        showing = url
        let viewer = QLPreviewController()
        viewer.dataSource = self
        viewer.delegate = self
        top.present(viewer, animated: true)
    }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { showing == nil ? 0 : 1 }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { (showing ?? URL(fileURLWithPath: "/")) as NSURL }

    func previewControllerDidDismiss(_ controller: QLPreviewController) {
        if let url = showing { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }   // the temporary copy goes away with the viewer
        showing = nil
    }

    private static func topController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        var top = scene?.windows.first(where: { $0.isKeyWindow })?.rootViewController ?? scene?.windows.first?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }
}
