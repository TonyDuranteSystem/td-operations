package com.tonydurante.myllcmanager

import android.net.Uri
import android.webkit.CookieManager
import android.webkit.WebStorage
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tonydurante.myllcmanager.core.AlertRouting
import com.tonydurante.myllcmanager.core.MeOutcome
import com.tonydurante.myllcmanager.core.MeRules
import com.tonydurante.myllcmanager.core.PageRules
import com.tonydurante.myllcmanager.core.SelectionRules
import com.tonydurante.myllcmanager.core.SignOutRules
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/** What the model needs from the web view on screen (it never holds the web view itself, so nothing leaks when the screen is rebuilt). */
interface WebController {
    val currentUrl: String?
    fun load(url: String)
    fun reload()
    fun clearEverything()
}

/**
 * The state of the client app: who is signed in, the bottom bar and the Menu, and the page on screen. The same job as the iPhone app's `ClientModel`
 * (ios/TDClient/App/ClientModel.swift); alerts arrive with version 2 of the Android app.
 */
class ClientViewModel : ViewModel() {
    var me by mutableStateOf<Me?>(null)
        private set

    /** what the server last said to "who am I": null = not asked yet */
    var meOutcome by mutableStateOf<MeOutcome?>(null)
        private set
    var menuOpen by mutableStateOf(false)
    var currentPath by mutableStateOf("/")
        private set

    /** the `tab` of the page on screen (TD Billing is the invoices page with `?tab=billing`) */
    var currentTab by mutableStateOf<String?>(null)
        private set

    /** the page could not be loaded (no connection ...) */
    var loadFailed by mutableStateOf(false)

    /** the server could not be told to forget this phone: the person is NOT signed out yet */
    var signOutFailed by mutableStateOf(false)

    /** a brand-new web view is made at every sign-out, so no page of the person who left stays in its history (back button) */
    var webEpoch by mutableIntStateOf(0)
        private set

    var controller: WebController? = null
    var userAgent: String = ""

    /** the address a page failed to load (so "Try again" opens THAT page, not the one before it) */
    var failedUrl: String? = null

    /** the company the page on screen shows (the page tells the app; see SelectionRules): the bar and the Menu list describe THAT company */
    private var selection = ""
    private var signingOut = false

    /** bumped at every sign-out, so an answer that was already on its way for the person who left is thrown away */
    private var meEpoch = 0

    // MARK: pages

    /** Only a same-site path is ever opened from the Menu or the bar (never an address of another site, never protocol-relative). */
    fun open(path: String) {
        val safe = AlertRouting.safeRelativePath(path) ?: return
        menuOpen = false
        loadFailed = false
        failedUrl = null
        controller?.load(AppConfig.serverUrl + safe)
    }

    fun retry() {
        loadFailed = false
        val failed = failedUrl
        failedUrl = null
        val c = controller ?: return
        if (failed != null) c.load(failed) else if (c.currentUrl != null) c.reload() else c.load(AppConfig.serverUrl + "/portal")
    }

    /** The page on screen changed address (the portal moves between pages without a full load): remember it and ask who is signed in again. */
    fun onAddressChanged(url: String?) {
        val uri = url?.let { Uri.parse(it) }
        currentPath = uri?.path ?: "/"
        currentTab = uri?.getQueryParameter("tab")
        requestRefresh(700)
    }

    fun onPageFinished() {
        loadFailed = false
        failedUrl = null
        requestRefresh(0)
    }

    /** The page tells the app which company it shows; the bar and the Menu list are asked again about THAT company. */
    fun setSelection(query: String) {
        if (query == selection) return
        selection = query
        requestRefresh(0)
    }

    // MARK: who am I

    fun requestRefresh(afterMs: Long) {
        viewModelScope.launch {
            if (afterMs > 0) delay(afterMs)
            refreshMe()
        }
    }

    /**
     * Asks the server who this person is and what they can open (the bar and the Menu come from the answer). Not signed in or the app switched off = no bar;
     * a hiccup (a server fault, no connection) KEEPS the bar the person already has.
     */
    private suspend fun refreshMe() {
        if (signingOut) return
        val host = controller?.currentUrl?.let { Uri.parse(it).host }
        if (!PageRules.mayRunRequest(host, AppConfig.serverHost)) return
        val epoch = meEpoch
        val cookie = CookieManager.getInstance().getCookie(AppConfig.serverUrl)
        val answer = ServerCalls.get(SelectionRules.meAddress(selection), cookie, userAgent)
        // a sign-out happened while this was on its way: the answer is about the person who left
        if (epoch != meEpoch || signingOut) return
        val outcome = MeRules.outcome(answer?.status)
        meOutcome = outcome
        when (outcome) {
            MeOutcome.SIGNED_IN -> parseMe(answer?.text.orEmpty())?.let { me = it }
            MeOutcome.SIGNED_OUT, MeOutcome.OFF -> me = null
            MeOutcome.UNAVAILABLE -> Unit
        }
    }

    // MARK: sign out

    /**
     * Ends the sign-in on this phone and shows the portal's sign-in page. The portal has no sign-out button in the app (its side menu is hidden), so this is
     * the app's own. Version 1 has no alerts, so there is no phone to tell the server to forget: the check is the same rule as the iPhone's
     * (`SignOutRules`) with "nothing to tell" = 200.
     */
    fun signOut() {
        if (signingOut) return
        viewModelScope.launch {
            signingOut = true
            meEpoch += 1
            try {
                val removal: Int? = 200 // nothing to tell the server in version 1 (no phone was saved for alerts)
                if (!SignOutRules.mayEndSession(removal)) {
                    signOutFailed = true
                    return@launch
                }
                signOutFailed = false
                clearCookies()
                WebStorage.getInstance().deleteAllData()
                controller?.clearEverything()
                me = null
                meOutcome = MeOutcome.SIGNED_OUT
                selection = ""
                menuOpen = false
                meEpoch += 1
                loadFailed = false
                failedUrl = null
                webEpoch += 1 // a brand-new web view (it opens the portal's sign-in page)
            } finally {
                signingOut = false
            }
        }
    }

    private suspend fun clearCookies() = suspendCancellableCoroutine { cont ->
        CookieManager.getInstance().removeAllCookies { cont.resume(Unit) }
        CookieManager.getInstance().flush()
    }

    /** The web view was rebuilt after the system stopped its process: start a fresh one (it opens the portal). */
    fun rebuildWebView() {
        webEpoch += 1
    }
}
