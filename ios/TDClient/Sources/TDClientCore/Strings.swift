// The plain-language messages of the client app, in English and Italian (the portal's clients are both). The phone's language picks one.
// Pure, so every message exists in both languages and a test checks it. Everything else on screen (the bar, the Menu list, the pages) comes
// from the server in the person's own language.
import Foundation

public enum Msg: CaseIterable {
    case menuTitle, close, cancel, signInFirst, signOut
    case couldntLoad, tryAgain, noConnection
    case alertsTitle, alertsBody, alertsTurnOn, alertsNotNow, alertsOffStrip, alertsOpenSettings
    case fileNotOpened, ok
    case menuUnavailable, signOutFailed
}

public enum Strings {
    public static func text(_ m: Msg, italian: Bool) -> String { italian ? it(m) : en(m) }

    public static func isItalian(_ preferred: [String]) -> Bool { (preferred.first ?? "").lowercased().hasPrefix("it") }

    static func en(_ m: Msg) -> String {
        switch m {
        case .menuTitle: return "Menu"
        case .close: return "Close"
        case .cancel: return "Cancel"
        case .signInFirst: return "Sign in on the portal page first."
        case .signOut: return "Sign out"
        case .couldntLoad: return "Couldn't load this."
        case .tryAgain: return "Try again"
        case .noConnection: return "No connection. Check your internet and try again."
        case .alertsTitle: return "Get alerts for new updates"
        case .alertsBody: return "Your lock screen shows who wrote or what kind of update it is, never the details."
        case .alertsTurnOn: return "Turn on alerts"
        case .alertsNotNow: return "Not now"
        case .alertsOffStrip: return "Alerts are off. You may miss updates."
        case .alertsOpenSettings: return "Open iPhone Settings"
        case .fileNotOpened: return "Couldn't open this file. Try again."
        case .ok: return "OK"
        case .menuUnavailable: return "The menu isn't available right now. Try again in a moment."
        case .signOutFailed: return "Couldn't sign out. Check your connection and try again."
        }
    }

    static func it(_ m: Msg) -> String {
        switch m {
        case .menuTitle: return "Menu"
        case .close: return "Chiudi"
        case .cancel: return "Annulla"
        case .signInFirst: return "Accedi prima nella pagina del portale."
        case .signOut: return "Esci"
        case .couldntLoad: return "Impossibile caricare."
        case .tryAgain: return "Riprova"
        case .noConnection: return "Nessuna connessione. Controlla internet e riprova."
        case .alertsTitle: return "Ricevi avvisi per le novità"
        case .alertsBody: return "La schermata di blocco mostra chi ha scritto o che tipo di novità è, mai i dettagli."
        case .alertsTurnOn: return "Attiva gli avvisi"
        case .alertsNotNow: return "Non ora"
        case .alertsOffStrip: return "Gli avvisi sono spenti. Potresti perdere delle novità."
        case .alertsOpenSettings: return "Apri Impostazioni di iPhone"
        case .fileNotOpened: return "Impossibile aprire il file. Riprova."
        case .ok: return "Va bene"
        case .menuUnavailable: return "Il menu non è disponibile in questo momento. Riprova tra poco."
        case .signOutFailed: return "Impossibile uscire. Controlla la connessione e riprova."
        }
    }
}
