// One web view for one tab (or for the sign-in page). It keeps its page while the person moves between tabs, shows the existing screen,
// keeps pages of OUR server inside the app and sends every other link to Safari.
import SwiftUI
import WebKit

/// Receives the one message a web screen may send: "you". Only a page of OUR server, in the main frame, is believed (a payment frame or an
/// embedded player must never be able to open the app's screens).
final class YouBridge: NSObject, WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.host.lowercased() == AppConfig.serverHost.lowercased(), (message.body as? String) == "you" else { return }
        Task { @MainActor in AppModel.shared.showYou = true }
    }
}

@MainActor
final class WebHost: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView
    @Published var failed = false
    /// can the page go back, and which address is it on: the app draws its own Back bar when the tab has left its own screens (see BackRules)
    @Published var canGoBack = false
    @Published var currentPath: String?
    var onFinish: (() -> Void)?
    private var observers: [NSKeyValueObservation] = []
    /// this host's own page, and whether its first load has started (a tab that is not on screen waits: see TabLoading)
    let path: String
    private(set) var started = false

    init(path: String, loadNow: Bool = true) {
        self.path = path
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = WKWebsiteDataStore.default()
        cfg.applicationNameForUserAgent = "\(ServerRules.userAgentToken)\(AppConfig.version)"   // the one thing that switches the web screens into app mode
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        // a web screen's round "You" button asks the app to open its "You" screen (web: components/app-mode/app-you-button.tsx)
        cfg.userContentController.add(YouBridge(), name: "tdsocial")
        #if DEBUG
        // simulator tests only: production has no orange test-server bar, so hide it to see (and measure) the real layout
        cfg.userContentController.addUserScript(WKUserScript(source: "var s=document.createElement('style');s.textContent='.fixed.top-0.bg-orange-500{display:none!important}';document.documentElement.appendChild(s);", injectionTime: .atDocumentEnd, forMainFrameOnly: false))
        #endif
        webView = WKWebView(frame: .zero, configuration: cfg)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false   // Portal chats and the Inbox move by state, not by address
        webView.scrollView.contentInsetAdjustmentBehavior = .automatic
        webView.isInspectable = true
        observers = [
            webView.observe(\.canGoBack, options: [.initial, .new]) { [weak self] web, _ in Task { @MainActor in self?.canGoBack = web.canGoBack } },
            webView.observe(\.url, options: [.initial, .new]) { [weak self] web, _ in Task { @MainActor in self?.currentPath = web.url?.path } },
        ]
        if loadNow { load(path) }
    }

    /// starts the first load if it has not started (a tab that waited is opened, or its turn in the background came)
    func startIfNeeded() { if !started { load(path) } }

    func load(_ path: String) {
        failed = false
        started = true
        guard let url = URL(string: AppConfig.serverURL.absoluteString + path) else { return }
        webView.load(URLRequest(url: url))
    }

    func reload() { failed = false; if webView.url == nil { load(path) } else { webView.reload() } }   // a page that never loaded tries ITS OWN page again

    // MARK: navigation

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { failed = false; onFinish?() }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { noteFailure(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { noteFailure(error) }
    private func noteFailure(_ error: Error) {
        let e = error as NSError
        if e.code == NSURLErrorCancelled { return }   // a page replaced by another one is not a failure
        if e.domain == "WebKitErrorDomain" && e.code == 102 { return }   // "frame load interrupted": the page turned into a file for the viewer, the screen under it is fine
        failed = true
    }

    // a page that turns out to be a FILE (a PDF, a picture, an attachment) opens in the phone's viewer, over the app, with Done and Share:
    // it never replaces the screen, so there is nothing to get stuck on
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let http = navigationResponse.response as? HTTPURLResponse
        if navigationResponse.isForMainFrame, FileRules.opensAsFile(mimeType: navigationResponse.response.mimeType, contentDisposition: http?.value(forHTTPHeaderField: "Content-Disposition")) {
            decisionHandler(.download)
        } else {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { FileOpener.shared.adopt(download) }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { FileOpener.shared.adopt(download) }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload, let u = action.request.url, (u.scheme == "http" || u.scheme == "https"), LinkRules.staysInApp(host: u.host, serverHost: AppConfig.serverHost) {
            decisionHandler(.download)   // a link marked "download" on one of our own pages
            return
        }
        guard let url = action.request.url, let scheme = url.scheme?.lowercased() else { decisionHandler(.cancel); return }
        if scheme == "about" || scheme == "blob" || scheme == "data" { decisionHandler(.allow); return }
        if (scheme == "http" || scheme == "https") && LinkRules.staysInApp(host: url.host, serverHost: AppConfig.serverHost) { decisionHandler(.allow); return }
        // another site, a mail or phone link, a file: hand it to the phone (Safari, Mail, Phone ...)
        if action.navigationType == .linkActivated || action.targetFrame == nil || action.targetFrame?.isMainFrame == true {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
        } else {
            decisionHandler(.allow)   // a frame inside the page (an embedded player, a payment frame)
        }
    }

    // MARK: new windows, microphone and camera, the page's own dialogs

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // target=_blank / window.open: our own pages open in this same view, anything else goes to Safari
        if let url = action.request.url {
            if LinkRules.staysInApp(host: url.host, serverHost: AppConfig.serverHost) { webView.load(action.request) } else { UIApplication.shared.open(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        // only OUR server may use the microphone / camera; iPhone itself still asks the person (once)
        decisionHandler(LinkRules.staysInApp(host: origin.host, serverHost: AppConfig.serverHost) ? .grant : .deny)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        present(message: message, buttons: ["OK"]) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        present(message: message, buttons: ["OK", "Cancel"]) { completionHandler($0 == 0) }
    }

    private func present(message: String, buttons: [String], done: @escaping (Int) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        for (i, b) in buttons.enumerated() { alert.addAction(UIAlertAction(title: b, style: i == 0 ? .default : .cancel) { _ in done(i) }) }
        guard let root = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow?.rootViewController }).first else { done(buttons.count - 1); return }
        var top = root
        while let next = top.presentedViewController { top = next }
        top.present(alert, animated: true)
    }
}

struct WebHostView: UIViewRepresentable {
    let host: WebHost
    func makeUIView(context: Context) -> WKWebView { host.webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
