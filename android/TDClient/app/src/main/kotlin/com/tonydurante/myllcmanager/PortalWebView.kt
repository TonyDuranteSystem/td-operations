package com.tonydurante.myllcmanager

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.tonydurante.myllcmanager.core.FileRules
import com.tonydurante.myllcmanager.core.LinkRules
import com.tonydurante.myllcmanager.core.Msg
import com.tonydurante.myllcmanager.core.SelectionRules
import org.json.JSONObject
import android.util.Base64

/**
 * The portal in a web view. Its browser name ends in `TDClient/<version> TDAndroid`, which is how the portal knows to draw itself for the app (no website menu,
 * a round Menu button at the top right). The Menu button and the company choice come through one message door (`tdclientAndroid`) that exists only on OUR
 * pages and is checked again here (main frame of our site only). Our own pages (and Stripe's card page, for "Pay Now") stay in the app; every other link
 * opens in the browser. A page that turns out to be a file opens in the phone's own viewer. Same behaviour as the iPhone app (ios/TDClient/App/WebHost.swift).
 */
object PortalWebView {
    @SuppressLint("SetJavaScriptEnabled")
    fun create(activity: MainActivity, vm: ClientViewModel): WebView {
        val web = WebView(activity)
        web.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        web.setBackgroundColor(0xFFF8FAFC.toInt()) // the portal's own light background: a loading page never flashes dark

        val s = web.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true // the portal keeps small things in the page's own storage
        s.allowFileAccess = false
        s.allowContentAccess = false
        s.setSupportMultipleWindows(true)
        s.javaScriptCanOpenWindowsAutomatically = true
        s.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        s.userAgentString = s.userAgentString + " " + AppConfig.userAgentSuffix // the one thing that switches the portal into app mode
        vm.userAgent = s.userAgentString

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false)

        val origins = LinkRules.ownOrigins(AppConfig.serverUrl)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "tdclientAndroid", origins) { _, message, _, isMainFrame, _ ->
                // only a page of OUR site (the door exists only there), in the main frame, is believed (a payment frame must never be able to open the Menu)
                if (isMainFrame) handleMessage(activity, vm, message)
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, PageBridge.SCRIPT, origins)
        }

        web.webViewClient = Client(activity, vm)
        web.webChromeClient = Chrome(activity, vm)
        web.setDownloadListener { url, _, contentDisposition, mimeType, _ -> onDownload(activity, web, url, contentDisposition, mimeType) }

        vm.controller = object : WebController {
            override val currentUrl: String? get() = web.url
            override fun load(url: String) = web.loadUrl(url)
            override fun reload() = web.reload()
            override fun clearEverything() {
                web.clearCache(true)
                web.clearHistory()
                web.clearFormData()
            }
        }
        web.loadUrl(AppConfig.serverUrl + "/portal")
        return web
    }

    private fun handleMessage(activity: MainActivity, vm: ClientViewModel, message: WebMessageCompat) {
        val body = message.data ?: return
        when {
            body == "menu" -> vm.menuOpen = true
            body.startsWith("selection:") -> SelectionRules.query(body)?.let { vm.setSelection(it) }
            body.startsWith("file:") -> activity.receiveFile(body.removePrefix("file:"))
            body.startsWith("file-error:") -> activity.say(Msg.FILE_NOT_OPENED)
        }
    }

    private fun onDownload(activity: MainActivity, web: WebView, url: String, contentDisposition: String?, mimeType: String?) {
        val hint = FileRules.nameFromDisposition(contentDisposition) ?: URLUtil.guessFileName(url, contentDisposition, mimeType)
        when {
            url.startsWith("blob:") -> web.evaluateJavascript("window.__tdSendBlob && window.__tdSendBlob(${JSONObject.quote(url)}, ${JSONObject.quote(hint)})", null)
            url.startsWith("http://") || url.startsWith("https://") ->
                if (LinkRules.ownSite(Uri.parse(url).host, AppConfig.serverHost)) activity.downloadAndOpen(url, hint, mimeType) else activity.openExternal(Uri.parse(url))
            else -> activity.say(Msg.FILE_NOT_OPENED)
        }
    }

    private class Client(val activity: MainActivity, val vm: ClientViewModel) : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false // a frame inside the page (a payment frame, an embedded player)
            val url = request.url
            val scheme = url.scheme?.lowercase().orEmpty()
            if (scheme == "about" || scheme == "data") return false
            if (scheme == "blob") { // a file opened as a page: hand it to the app
                view.evaluateJavascript("window.__tdSendBlob && window.__tdSendBlob(${JSONObject.quote(url.toString())}, '')", null)
                return true
            }
            if ((scheme == "http" || scheme == "https") && LinkRules.staysInApp(url.host, AppConfig.serverHost)) return false
            activity.openExternal(url) // another site, a mail or phone link: hand it to the phone (browser, mail, phone ...)
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
            // an older web view cannot run the script at the start of a page: it is run when the page has loaded (see onPageFinished)
        }

        /** The web view's own "Webpage not available" page counts as a page that loaded: it must never clear our "Couldn't load this" screen. */
        private fun isErrorPage(url: String?) = url != null && url.startsWith("chrome-error:")

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            activity.backCallback.isEnabled = view.canGoBack()
            if (isErrorPage(url)) return
            // the portal moves between pages without a full load (sign-in, the bar, links): ask who is signed in again on every address change
            vm.onAddressChanged(url)
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (isErrorPage(url)) return
            // Android reports "finished" for an address that failed to load, too: that must not clear the "Couldn't load this" screen
            if (vm.loadFailed && url != null && url == vm.failedUrl) return
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) view.evaluateJavascript(PageBridge.SCRIPT, null)
            if (url != null && url != "about:blank") vm.onPageFinished()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            val scheme = request.url.scheme?.lowercase()
            if (scheme == "blob" || scheme == "data") return
            if (error.description?.toString()?.contains("ERR_ABORTED") == true) return // a page replaced by another one (or a download) is not a failure
            vm.failedUrl = request.url.toString()
            vm.loadFailed = true
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            vm.rebuildWebView() // the system stopped the page's process: start a fresh page instead of closing the app
            return true
        }
    }

    private class Chrome(val activity: MainActivity, val vm: ClientViewModel) : WebChromeClient() {
        override fun onShowFileChooser(webView: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean =
            activity.chooseFiles(callback, params)

        override fun onPermissionRequest(request: PermissionRequest) {
            // only OUR site may use the microphone; the phone itself still asks the person (once). The camera video is never granted: photos come from the camera app.
            val ours = LinkRules.mayUseMedia(request.origin.host, AppConfig.serverHost)
            val wantsAudio = request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)
            if (!ours || !wantsAudio) { request.deny(); return }
            activity.askAudioPermission { granted ->
                if (granted) request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else request.deny()
            }
        }

        // links that open "in a new tab": our own pages open in this same window (the app has one window), anything else goes to the browser
        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            val holder = WebView(view.context)
            holder.webViewClient = object : WebViewClient() {
                private var handled = false
                private fun route(url: Uri) {
                    if (handled) return
                    handled = true
                    val scheme = url.scheme?.lowercase().orEmpty()
                    if (scheme == "blob") view.evaluateJavascript("window.__tdSendBlob && window.__tdSendBlob(${JSONObject.quote(url.toString())}, '')", null)
                    else if ((scheme == "http" || scheme == "https") && LinkRules.staysInApp(url.host, AppConfig.serverHost)) view.loadUrl(url.toString())
                    else if (scheme != "about") activity.openExternal(url)
                    Handler(Looper.getMainLooper()).post { holder.destroy() }
                }
                override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean { route(request.url); return true }
                override fun onPageStarted(v: WebView, url: String?, favicon: Bitmap?) { url?.let { route(Uri.parse(it)) } }
            }
            (resultMsg.obj as WebView.WebViewTransport).webView = holder
            resultMsg.sendToTarget()
            return true
        }

        override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
            activity.showDialog(message.orEmpty(), listOf(AppConfig.say(Msg.OK))) { result.confirm() }
            return true
        }

        override fun onJsConfirm(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
            activity.showDialog(message.orEmpty(), listOf(AppConfig.say(Msg.OK), AppConfig.say(Msg.CANCEL))) { which -> if (which == 0) result.confirm() else result.cancel() }
            return true
        }
    }

    /** Decodes the file the page handed over (`{name, type, data}` with the bytes in base64) and returns it, or null when it is not a usable file. */
    fun decodeFile(json: String): Triple<String, String?, ByteArray>? = try {
        val o = JSONObject(json)
        val data = o.getString("data")
        if (data.length.toLong() * 3 / 4 > FileHandler.MAX_BYTES) null
        else Triple(o.optString("name"), o.optString("type").ifEmpty { null }, Base64.decode(data, Base64.DEFAULT))
    } catch (e: Exception) {
        null
    }
}
