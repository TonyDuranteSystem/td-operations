package com.tonydurante.myllcmanager

import androidx.core.os.LocaleListCompat
import com.tonydurante.myllcmanager.core.Msg
import com.tonydurante.myllcmanager.core.ServerRules
import com.tonydurante.myllcmanager.core.Strings
import java.net.URI

/**
 * Settings that differ per build flavour (sandbox / production). They are filled in by the build (app/build.gradle.kts):
 * the server address. Nothing here is a secret.
 */
object AppConfig {
    val serverUrl: String = BuildConfig.SERVER_URL
    val serverHost: String = URI(BuildConfig.SERVER_URL).host ?: ""
    val version: String = BuildConfig.VERSION_NAME

    /** Added to the web view's browser name: `TDClient/<version> TDAndroid`. The server only looks for `TDClient/`; the rest says which phone. */
    val userAgentSuffix: String = ServerRules.userAgentSuffix(version)

    private fun italian(): Boolean {
        val locales = LocaleListCompat.getAdjustedDefault()
        return Strings.isItalian((0 until locales.size()).mapNotNull { locales.get(it)?.language })
    }

    fun say(m: Msg): String = Strings.text(m, italian())
}
