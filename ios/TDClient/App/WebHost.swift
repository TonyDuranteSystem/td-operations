import SwiftUI
import WebKit

/// The portal in a web view. Its browser name ends in `TDClient/2.0`, which is how the portal knows to draw itself for the app (no website menu, a round Menu
/// button at the top right). The Menu button posts "menu" to the `tdclient` message handler; everything else is the website's own page.
struct WebHost: UIViewRepresentable {
    @EnvironmentObject var model: ClientModel

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.applicationNameForUserAgent = "TDClient/2.0"
        config.websiteDataStore = .default()
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "tdclient")
        config.userContentController = controller
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = true
        view.isInspectable = true
        context.coordinator.watch(view)
        model.web = view
        view.load(URLRequest(url: model.serverURL.appendingPathComponent("portal")))
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
                    await self.model.registerDevice()
                }
            }
        }

        func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
            if message.name == "tdclient", (message.body as? String) == "menu" { Task { @MainActor in self.model.showMenu = true } }
        }

        // a page finished loading: ask who is signed in (the bar and Menu come from the answer) and save this phone for alerts
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            Task { @MainActor in
                await self.model.refreshMe()
                await self.model.registerDevice()
            }
        }

        // "open in a new tab" links stay in this window (the app has one window)
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if navigationAction.targetFrame == nil, let url = navigationAction.request.url { webView.load(URLRequest(url: url)) }
            return nil
        }
    }
}
