package com.tonydurante.myllcmanager

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.lifecycleScope
import com.tonydurante.myllcmanager.core.LinkRules
import com.tonydurante.myllcmanager.core.Msg
import com.tonydurante.myllcmanager.core.PageRules
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * The client Android app (MyLLC Manager), dev job 2c751252. A thin native shell: the portal's own pages in a web view that says it is the client app
 * (browser name ends in `TDClient/`), a native bottom bar and Menu drawn from the server's own answer (/api/portal/app/me). The same app as the iPhone one
 * (ios/TDClient/App/TDClientApp.swift); alerts arrive with version 2.
 */
class MainActivity : ComponentActivity() {
    private val vm: ClientViewModel by viewModels()

    // the file picker / camera for an "upload" button on a page
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var photoFile: File? = null
    private var photoUri: Uri? = null

    private var audioAnswer: ((Boolean) -> Unit)? = null

    /** the Back button goes back in the page's history; at the start of the history it leaves the app as usual */
    val backCallback = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            webView?.let { if (it.canGoBack()) it.goBack() }
        }
    }
    private var webView: WebView? = null

    private val filePicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = fileCallback ?: return@registerForActivityResult
        fileCallback = null
        val picked = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        val photo = photoFile
        val uris: Array<Uri>? = when {
            !picked.isNullOrEmpty() -> picked
            result.resultCode == RESULT_OK && photo != null && photo.length() > 0 && photoUri != null -> arrayOf(photoUri!!)
            else -> null
        }
        callback.onReceiveValue(uris)
        if (uris == null) photo?.delete()
        photoFile = null
        photoUri = null
    }

    private val audioPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        audioAnswer?.invoke(granted)
        audioAnswer = null
    }

    @OptIn(ExperimentalLayoutApi::class, ExperimentalFoundationApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        FileHandler.cleanOld(this)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        onBackPressedDispatcher.addCallback(this, backCallback)
        lifecycle.addObserver(LifecycleEventObserver { _, event ->
            // coming back to the app: the numbers on the bar may have changed meanwhile
            if (event == Lifecycle.Event.ON_RESUME) vm.requestRefresh(0)
        })

        setContent {
            MaterialTheme(colorScheme = lightColorScheme(primary = Color(0xFF0A60D0), surface = Color.White, background = Color(0xFFF8FAFC))) {
                Column(
                    Modifier.fillMaxSize().background(Color(0xFFF8FAFC)).statusBarsPadding().imePadding().semantics { testTagsAsResourceId = true },
                ) {
                    Box(Modifier.weight(1f)) {
                        // a brand-new web view is made at every sign-out (no page of the person who left stays in its history)
                        key(vm.webEpoch) {
                            AndroidView(
                                factory = { PortalWebView.create(this@MainActivity, vm).also { webView = it } },
                                modifier = Modifier.fillMaxSize(),
                                onRelease = { web ->
                                    if (webView === web) webView = null
                                    web.destroy()
                                },
                            )
                        }
                        if (vm.loadFailed) LoadFailedView(vm)
                    }
                    // the keyboard covers the bar, as on the iPhone
                    val me = vm.me
                    if (me != null && !WindowInsets.isImeVisible) BottomBar(me, vm)
                }
                if (vm.menuOpen) MenuSheet(vm)
            }
        }
    }

    // MARK: what the page may ask of the phone

    /** An upload button on a page: files, or a photo from the camera app (no camera permission needed: the camera app takes the photo). */
    fun chooseFiles(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        fileCallback?.onReceiveValue(null) // an earlier picker that never answered
        fileCallback = callback
        val content = params.createIntent()
        val initial = mutableListOf<Intent>()
        val types = params.acceptTypes.filter { it.isNotBlank() }
        if (types.isEmpty() || types.any { it.startsWith("image") || it == "*/*" }) {
            val folder = File(cacheDir, "td-photos").apply { mkdirs() }
            val file = File(folder, "IMG_${System.currentTimeMillis()}.jpg")
            val uri = FileProvider.getUriForFile(this, "${BuildConfig.APPLICATION_ID}.files", file)
            photoFile = file
            photoUri = uri
            initial += Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                .putExtra(MediaStore.EXTRA_OUTPUT, uri)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(content, null).putExtra(Intent.EXTRA_INITIAL_INTENTS, initial.toTypedArray())
        return try {
            filePicker.launch(chooser)
            true
        } catch (e: Exception) {
            fileCallback = null
            callback.onReceiveValue(null)
            false
        }
    }

    /** The page wants the microphone (a voice note): the phone asks the person once; `answer` gets the result. */
    fun askAudioPermission(answer: (Boolean) -> Unit) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            answer(true)
        } else {
            audioAnswer?.invoke(false)
            audioAnswer = answer
            audioPermission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    /** Another site, a mail or phone link: handed to the phone (browser, mail, phone ...). */
    fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            say(Msg.FILE_NOT_OPENED)
        }
    }

    /** A file the page handed over as text (`{name, type, data}`): saved and opened in the phone's viewer. */
    fun receiveFile(json: String) {
        val decoded = PortalWebView.decodeFile(json)
        if (decoded == null) { say(Msg.FILE_NOT_OPENED); return }
        val (name, type, bytes) = decoded
        lifecycleScope.launch {
            val file = withContext(Dispatchers.IO) { FileHandler.save(this@MainActivity, name, type, bytes) }
            if (!FileHandler.open(this@MainActivity, file, type)) say(Msg.FILE_NOT_OPENED)
        }
    }

    /** A file at one of our own addresses (a link the page offers for download): fetched with the page's sign-in, then opened like any other file. */
    fun downloadAndOpen(url: String, suggestedName: String, mimeType: String?) {
        val host = Uri.parse(url).host
        if (!PageRules.mayRunRequest(host, AppConfig.serverHost) && !LinkRules.ownSite(host, AppConfig.serverHost)) { say(Msg.FILE_NOT_OPENED); return }
        val cookie = android.webkit.CookieManager.getInstance().getCookie(url)
        lifecycleScope.launch {
            val saved = withContext(Dispatchers.IO) {
                try {
                    val c = URL(url).openConnection() as HttpURLConnection
                    try {
                        c.connectTimeout = 15_000
                        c.readTimeout = 60_000
                        c.setRequestProperty("User-Agent", vm.userAgent)
                        if (!cookie.isNullOrEmpty()) c.setRequestProperty("Cookie", cookie)
                        if (c.responseCode !in 200..299 || c.contentLengthLong > FileHandler.MAX_BYTES) return@withContext null
                        val name = com.tonydurante.myllcmanager.core.FileRules.nameFromDisposition(c.getHeaderField("Content-Disposition")) ?: suggestedName
                        val type = c.contentType ?: mimeType
                        Triple(FileHandler.save(this@MainActivity, name, type, c.inputStream.use { it.readBytes() }), type, name)
                    } finally {
                        c.disconnect()
                    }
                } catch (e: Exception) {
                    null
                }
            }
            if (saved == null || !FileHandler.open(this@MainActivity, saved.first, saved.second)) say(Msg.FILE_NOT_OPENED)
        }
    }

    /** A plain message for the person (a page's own alert, or "couldn't open this file"). */
    fun say(message: Msg) = showDialog(AppConfig.say(message), listOf(AppConfig.say(Msg.OK))) {}

    fun showDialog(message: String, buttons: List<String>, done: (Int) -> Unit) {
        if (isFinishing || isDestroyed) { done(buttons.size - 1); return }
        val builder = AlertDialog.Builder(this).setMessage(message).setCancelable(false)
        builder.setPositiveButton(buttons[0]) { _, _ -> done(0) }
        if (buttons.size > 1) builder.setNegativeButton(buttons[1]) { _, _ -> done(1) }
        builder.show()
    }
}
