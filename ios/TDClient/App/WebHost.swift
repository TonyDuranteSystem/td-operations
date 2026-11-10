import SwiftUI
import WebKit

/// The portal in a web view. Its browser name ends in `TDClient/<version>`, which is how the portal knows to draw itself for the app (no website menu, a
/// round Menu button at the top right). The Menu button posts "menu" to the `tdclient` message handler; everything else is the website's own page.
/// Our own pages (and Stripe's card page, for "Pay Now") stay in the app; every other link opens in Safari. A page that turns out to be a file opens in
/// the phone's own viewer.
struct WebHost: UIViewRepresentable {
    @EnvironmentObject var model: ClientModel

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.applicationNameForUserAgent = "\(ServerRules.userAgentToken)\(AppConfig.version)"   // the one thing that switches the portal into app mode
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "tdclient")
        config.userContentController = controller
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = true
        #if DEBUG
        view.isInspectable = true
        #endif
        context.coordinator.watch(view)
        model.web = view
        // an alert tapped while the app was closed names the page to open first
        let first = model.pendingPath.flatMap { URL(string: $0, relativeTo: AppConfig.serverURL)?.absoluteURL } ?? AppConfig.serverURL.appendingPathComponent("portal")
        model.pendingPath = nil
        view.load(URLRequest(url: first))
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        let model: ClientModel
        private var observation: NSKeyValueObservation?
        init(model: ClientModel) { self.model = model }

        func watch(_ view: WKWebView) {
            // the portal moves between pages without a full load (sign-in, the bar, links): ask who is signed in again on every address change
            observation = view.observe(\.url, options: [.new]) { [weak self] v, _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.model.currentPath = v.url?.path ?? "/"
                    try? await Task.sleep(nanoseconds: 700_000_000)
                    await self.model.refreshMe()
                }
            }
        }

        func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
            // only a page of OUR site, in the main frame, is believed (a payment frame must never be able to open the app's Menu)
            guard message.name == "tdclient", message.frameInfo.isMainFrame, (message.body as? String) == "menu",
                  LinkRules.ownSite(host: message.frameInfo.securityOrigin.host, serverHost: AppConfig.serverHost) else { return }
            Task { @MainActor in self.model.sheet = .menu }
        }

        // MARK: loading

        // a page finished loading: ask who is signed in (the bar and Menu come from the answer)
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            Task { @MainActor in
                self.model.loadFailed = false
                await self.model.refreshMe()
            }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { noteFailure(error) }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { noteFailure(error) }
        private func noteFailure(_ error: Error) {
            let e = error as NSError
            if e.code == NSURLErrorCancelled { return }                          // a page replaced by another one is not a failure
            if e.domain == "WebKitErrorDomain" && e.code == 102 { return }       // "frame load interrupted": the page turned into a file for the viewer, the screen is fine
            Task { @MainActor in self.model.loadFailed = true }
        }

        // MARK: files

        // a page that turns out to be a FILE (a PDF, a picture, an attachment) opens in the phone's viewer, over the app, with Done and Share
        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            let http = navigationResponse.response as? HTTPURLResponse
            if navigationResponse.isForMainFrame, FileRules.opensAsFile(mimeType: navigationResponse.response.mimeType, contentDisposition: http?.value(forHTTPHeaderField: "Content-Disposition")) {
                decisionHandler(.download)
            } else {
                decisionHandler(.allow)
            }
        }

        // the download's delegate must be set BEFORE these methods return (WebKit starts delivering the file's steps right away), so no hop to another task here
        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { MainActor.assumeIsolated { FileOpener.shared.adopt(download) } }
        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { MainActor.assumeIsolated { FileOpener.shared.adopt(download) } }

        // MARK: links

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if action.shouldPerformDownload, let u = action.request.url, (u.scheme == "http" || u.scheme == "https"), LinkRules.ownSite(host: u.host, serverHost: AppConfig.serverHost) {
                decisionHandler(.download)   // a link marked "download" on one of our own pages
                return
            }
            guard let url = action.request.url, let scheme = url.scheme?.lowercased() else { decisionHandler(.cancel); return }
            if scheme == "about" || scheme == "blob" || scheme == "data" { decisionHandler(.allow); return }
            if (scheme == "http" || scheme == "https") && LinkRules.staysInApp(host: url.host, serverHost: AppConfig.serverHost) { decisionHandler(.allow); return }
            // another site, a mail or phone link: hand it to the phone (Safari, Mail, Phone ...)
            if action.navigationType == .linkActivated || action.targetFrame == nil || action.targetFrame?.isMainFrame == true {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
            } else {
                decisionHandler(.allow)   // a frame inside the page (a payment frame, an embedded player)
            }
        }

        // "open in a new tab" links: our own pages open in this same window (the app has one window), anything else goes to Safari
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url {
                if LinkRules.staysInApp(host: url.host, serverHost: AppConfig.serverHost) { webView.load(navigationAction.request) } else { UIApplication.shared.open(url) }
            }
            return nil
        }

        // MARK: the page's own permissions and dialogs

        // only OUR site may use the microphone / camera; the iPhone itself still asks the person (once)
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(LinkRules.mayUseMedia(host: origin.host, serverHost: AppConfig.serverHost) ? .grant : .deny)
        }

        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            present(message: message, buttons: [AppConfig.say(.ok)]) { _ in completionHandler() }
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            present(message: message, buttons: [AppConfig.say(.ok), AppConfig.say(.cancel)]) { completionHandler($0 == 0) }
        }

        private func present(message: String, buttons: [String], done: @escaping (Int) -> Void) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            for (i, b) in buttons.enumerated() { alert.addAction(UIAlertAction(title: b, style: i == 0 ? .default : .cancel) { _ in done(i) }) }
            guard let top = FileOpener.topController() else { done(buttons.count - 1); return }
            top.present(alert, animated: true)
        }
    }
}
