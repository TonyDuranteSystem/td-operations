package com.tonydurante.myllcmanager

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

data class NavItem(val key: String, val path: String, val label: String, val badge: Int)

/** The server's answer to "who am I and what can I open": the bottom bar and the Menu list are drawn from it (GET /api/portal/app/me). */
data class Me(val kind: String, val items: List<NavItem>, val bar: List<String>, val menuBadge: Int)

fun parseMe(text: String): Me? = try {
    val o = JSONObject(text)
    val items = o.getJSONArray("items").let { arr ->
        (0 until arr.length()).map { i ->
            val it = arr.getJSONObject(i)
            NavItem(it.getString("key"), it.getString("path"), it.getString("label"), it.optInt("badge", 0))
        }
    }
    val bar = o.getJSONArray("bar").let { arr -> (0 until arr.length()).map { arr.getString(it) } }
    Me(o.getString("kind"), items, bar, o.optInt("menuBadge", 0))
} catch (e: Exception) {
    null
}

/** One answer from the server: the status code and the text, or null when there was no answer at all (offline, a timeout). */
data class ServerAnswer(val status: Int, val text: String)

/**
 * The app's own questions to the server. They carry the page's sign-in (the same cookies the portal itself uses, read from the web view's cookie jar)
 * and run only while the page on screen is our server (`PageRules.mayRunRequest`, checked by the caller).
 */
object ServerCalls {
    suspend fun get(path: String, cookie: String?, userAgent: String): ServerAnswer? = withContext(Dispatchers.IO) {
        try {
            val c = URL(AppConfig.serverUrl + path).openConnection() as HttpURLConnection
            try {
                c.requestMethod = "GET"
                c.connectTimeout = 15_000
                c.readTimeout = 20_000
                c.instanceFollowRedirects = false // a redirect to the sign-in page must not look like an answer
                c.setRequestProperty("Accept", "application/json")
                c.setRequestProperty("Cache-Control", "no-store")
                c.setRequestProperty("User-Agent", userAgent)
                if (!cookie.isNullOrEmpty()) c.setRequestProperty("Cookie", cookie)
                val status = c.responseCode
                val stream = if (status in 200..299) c.inputStream else c.errorStream
                ServerAnswer(status, stream?.bufferedReader()?.use { it.readText() }.orEmpty())
            } finally {
                c.disconnect()
            }
        } catch (e: IOException) {
            null
        }
    }
}
