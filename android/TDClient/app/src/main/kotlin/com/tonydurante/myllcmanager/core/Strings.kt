// The plain-language messages of the client app, in English and Italian (the portal's clients are both). The phone's language picks one.
// Pure, so every message exists in both languages and a test checks it. Everything else on screen (the bar, the Menu list, the pages) comes
// from the server in the person's own language. Port of ios/TDClient/Sources/TDClientCore/Strings.swift (the alert messages arrive with alerts).
package com.tonydurante.myllcmanager.core

enum class Msg {
    MENU_TITLE, CLOSE, CANCEL, SIGN_IN_FIRST, SIGN_OUT,
    COULDNT_LOAD, TRY_AGAIN, NO_CONNECTION,
    FILE_NOT_OPENED, OK,
    MENU_UNAVAILABLE, SIGN_OUT_FAILED,
}

object Strings {
    fun text(m: Msg, italian: Boolean): String = if (italian) it(m) else en(m)

    /** The phone's first language choice decides: Italian only when it is the first one. */
    fun isItalian(preferred: List<String>): Boolean = (preferred.firstOrNull() ?: "").lowercase().startsWith("it")

    private fun en(m: Msg): String = when (m) {
        Msg.MENU_TITLE -> "Menu"
        Msg.CLOSE -> "Close"
        Msg.CANCEL -> "Cancel"
        Msg.SIGN_IN_FIRST -> "Sign in on the portal page first."
        Msg.SIGN_OUT -> "Sign out"
        Msg.COULDNT_LOAD -> "Couldn't load this."
        Msg.TRY_AGAIN -> "Try again"
        Msg.NO_CONNECTION -> "No connection. Check your internet and try again."
        Msg.FILE_NOT_OPENED -> "Couldn't open this file. Try again."
        Msg.OK -> "OK"
        Msg.MENU_UNAVAILABLE -> "The menu isn't available right now. Try again in a moment."
        Msg.SIGN_OUT_FAILED -> "Couldn't sign out. Check your connection and try again."
    }

    private fun it(m: Msg): String = when (m) {
        Msg.MENU_TITLE -> "Menu"
        Msg.CLOSE -> "Chiudi"
        Msg.CANCEL -> "Annulla"
        Msg.SIGN_IN_FIRST -> "Accedi prima nella pagina del portale."
        Msg.SIGN_OUT -> "Esci"
        Msg.COULDNT_LOAD -> "Impossibile caricare."
        Msg.TRY_AGAIN -> "Riprova"
        Msg.NO_CONNECTION -> "Nessuna connessione. Controlla internet e riprova."
        Msg.FILE_NOT_OPENED -> "Impossibile aprire il file. Riprova."
        Msg.OK -> "Va bene"
        Msg.MENU_UNAVAILABLE -> "Il menu non è disponibile in questo momento. Riprova tra poco."
        Msg.SIGN_OUT_FAILED -> "Impossibile uscire. Controlla la connessione e riprova."
    }
}
