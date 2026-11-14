// The rules of the client app's web view that do not need a phone to be tested: which links stay inside the app, which address a menu entry may open,
// and the browser name that switches the portal into app mode. Pure Kotlin, so every rule is unit-tested without an emulator.
// A port of the iPhone app's `ios/TDClient/Sources/TDClientCore/Rules.swift`: the two apps must behave the same, so a change to one is a change to both.
package com.tonydurante.myllcmanager.core

object ServerRules {
    /** The one thing that switches the portal's pages into app mode (lib/app-mode/app-mode.ts on the server: `CLIENT_APP_UA_TOKEN`, exact and case-sensitive). */
    const val USER_AGENT_TOKEN = "TDClient/"

    /** Said after the version so the server can tell the two phones apart later (the server still only looks for `TDClient/`). */
    const val ANDROID_MARK = "TDAndroid"

    fun userAgentSuffix(version: String): String = "$USER_AGENT_TOKEN$version $ANDROID_MARK"
}

object LinkRules {
    /** The website's own sibling for the portal host: the portal links to client forms and offers on `app.` (the same company, a different front door). */
    private const val PRODUCTION_PORTAL_HOST = "portal.tonydurante.us"
    private const val PRODUCTION_SIBLING_HOST = "app.tonydurante.us"

    /** Pages of OUR site: the server this build talks to, and (only on the live portal) its `app.` sibling. */
    fun ownSite(host: String?, serverHost: String): Boolean {
        val h = host?.lowercase()
        if (h.isNullOrEmpty()) return false
        val server = serverHost.lowercase()
        if (h == server) return true
        return server == PRODUCTION_PORTAL_HOST && h == PRODUCTION_SIBLING_HOST
    }

    /** The origins (scheme://host[:port]) of OUR site, for the page-to-app door: only these may talk to the app. `serverUrl` is the build's server address. */
    fun ownOrigins(serverUrl: String): Set<String> {
        val uri = java.net.URI(serverUrl)
        val host = (uri.host ?: "").lowercase()
        val origin = "${uri.scheme}://$host${if (uri.port > 0) ":${uri.port}" else ""}"
        return if (host == PRODUCTION_PORTAL_HOST) setOf(origin, "https://$PRODUCTION_SIBLING_HOST") else setOf(origin)
    }

    /** Stripe's card page: the portal's "Pay Now" sends the person there in the SAME window and Stripe sends them back to the portal afterwards. */
    fun isCardPage(host: String?): Boolean {
        val h = host?.lowercase()
        if (h.isNullOrEmpty()) return false
        return h == "stripe.com" || h.endsWith(".stripe.com")
    }

    /** Does a page the web view is about to open stay in the app? Our own pages and Stripe's card page do; everything else (other sites) opens in the browser. */
    fun staysInApp(host: String?, serverHost: String): Boolean = ownSite(host, serverHost) || isCardPage(host)

    /** Only OUR site may use the microphone (the phone itself still asks the person once). */
    fun mayUseMedia(host: String?, serverHost: String): Boolean = ownSite(host, serverHost)
}

object AlertRouting {
    /**
     * A link (from the Menu or the bar) is followed only when it is a same-site relative path: never another address, never a script.
     * null = not safe.
     */
    fun safeRelativePath(url: String?): String? {
        val u = url ?: return null
        if (!u.startsWith("/") || u.startsWith("//") || u.contains("\\") || u.contains(" ") || u.length > 500) return null
        if (u.any { it.isISOControl() }) return null
        return u
    }
}

/**
 * Which company the page on screen is showing. The portal page tells the app (a message `selection:<query>` from the main frame of OUR site) because the
 * website's company cookies never reach the app's server doors; the app then asks `/api/portal/app/me` about THAT company.
 */
object SelectionRules {
    private const val PREFIX = "selection:"
    private fun allowed(c: Char) = c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9' || c == '=' || c == '&' || c == '_' || c == '.' || c == '-'

    /** The query part of a `selection:` message ("" = nothing selected), or null when the message is not a selection or its words are not plain ids/words. */
    fun query(body: String): String? {
        if (!body.startsWith(PREFIX)) return null
        val q = body.removePrefix(PREFIX)
        if (q.length > 200 || !q.all { allowed(it) }) return null
        return q
    }

    fun meAddress(selection: String): String = if (selection.isEmpty()) "/api/portal/app/me" else "/api/portal/app/me?$selection"
}

/** What the server's answer to "who am I" means for the bottom bar. */
enum class MeOutcome {
    /** 200: the bar and the Menu list come from the answer */
    SIGNED_IN,

    /** 401 / 403: nobody signed in (or a login the app does not serve): no bar */
    SIGNED_OUT,

    /** 503: the app is switched off on the server: no bar (the website's own pages show instead) */
    OFF,

    /** anything else (a server hiccup, no connection): KEEP the bar the person already has */
    UNAVAILABLE;

    val clearsBar: Boolean get() = this == SIGNED_OUT || this == OFF
}

object MeRules {
    fun outcome(status: Int?): MeOutcome = when (status) {
        null -> MeOutcome.UNAVAILABLE
        200 -> MeOutcome.SIGNED_IN
        401, 403 -> MeOutcome.SIGNED_OUT
        503 -> MeOutcome.OFF
        else -> MeOutcome.UNAVAILABLE
    }
}

/** Which bottom-bar button is lit for the page on screen. TD Billing is drawn by the invoices page (`?tab=billing`), so the address alone is not enough. */
object BarRules {
    fun isActive(itemPath: String, currentPath: String, currentTab: String?): Boolean {
        val path = itemPath.substringBefore('?')
        if (path == "/portal") return currentPath == "/portal"
        if (path == "/portal/billing") return currentPath.startsWith("/portal/billing") || (currentPath == "/portal/invoices" && currentTab == "billing")
        if (path == "/portal/invoices") return currentPath.startsWith("/portal/invoices") && currentTab != "billing"
        return currentPath.startsWith(path)
    }
}

object PageRules {
    /**
     * The app's own questions to the server (who am I) run with the page's sign-in, so they may run only while the page IS our server: on a card page
     * or another site they would go to the wrong place with the wrong cookies.
     */
    fun mayRunRequest(pageHost: String?, serverHost: String): Boolean {
        val h = pageHost?.lowercase()
        if (h.isNullOrEmpty()) return false
        return h == serverHost.lowercase()
    }

    /** The portal's sign-in page. A person can sign in as someone else there without ever being signed out first. */
    fun isLoginPath(path: String): Boolean = path == "/portal/login" || path.startsWith("/portal/login/")
}

object SignOutRules {
    /**
     * The phone's login is ended only when the server could be told to forget the phone, or when there is nothing to tell (no session left, app switched off).
     * No answer at all (offline), "slow down" and a real server fault mean: do NOT sign out yet, so the old person's alerts never keep reaching this phone.
     */
    fun mayEndSession(removalStatus: Int?): Boolean {
        val s = removalStatus ?: return false
        if (s == 429) return false
        if (s >= 500 && s != 503) return false
        return true
    }
}
