// The plain-language messages (wording from the approved plan, section 10). English for everyone; Italian when the phone is set to Italian
// (Rocco's team). Pure, so every message exists in both languages and a test checks it.
import Foundation

public enum Msg: CaseIterable {
    case signingIn, checking, noConnectionBar, couldntLoad, tryAgain, noAccessTitle, noAccessBody, notSwitchedOn
    case alertsTitle, alertsBody, alertsTurnOn, alertsNotNow, alertsOffStrip, alertsOpenSettings
    case youTitle, signOut, signedOutSheet
}

public enum Strings {
    public static func text(_ m: Msg, italian: Bool) -> String { italian ? it(m) : en(m) }

    public static func isItalian(_ preferred: [String]) -> Bool { (preferred.first ?? "").lowercased().hasPrefix("it") }

    static func en(_ m: Msg) -> String {
        switch m {
        case .signingIn: return "Sign in with your Tony Durante account"
        case .checking: return "Checking your sign-in…"
        case .noConnectionBar: return "No connection. Messages you write are saved and will send when you're back online."
        case .couldntLoad: return "Couldn't load this."
        case .tryAgain: return "Try again"
        case .noAccessTitle: return "Your account is not set up for TD Social."
        case .noAccessBody: return "Ask Antonio to add you."
        case .notSwitchedOn: return "TD Social is not switched on yet."
        case .alertsTitle: return "Get alerts for new messages"
        case .alertsBody: return "The lock screen shows who wrote, never what."
        case .alertsTurnOn: return "Turn on alerts"
        case .alertsNotNow: return "Not now"
        case .alertsOffStrip: return "Alerts are off. You will miss messages."
        case .alertsOpenSettings: return "Open iPhone Settings"
        case .youTitle: return "You"
        case .signOut: return "Sign out"
        case .signedOutSheet: return "You were signed out. Sign in to carry on. Your unsent messages are kept."
        }
    }

    static func it(_ m: Msg) -> String {
        switch m {
        case .signingIn: return "Accedi con il tuo account Tony Durante"
        case .checking: return "Controllo l'accesso…"
        case .noConnectionBar: return "Nessuna connessione. I messaggi che scrivi vengono salvati e partono appena torni online."
        case .couldntLoad: return "Impossibile caricare."
        case .tryAgain: return "Riprova"
        case .noAccessTitle: return "Il tuo account non è abilitato a TD Social."
        case .noAccessBody: return "Chiedi ad Antonio di aggiungerti."
        case .notSwitchedOn: return "TD Social non è ancora attivo."
        case .alertsTitle: return "Ricevi avvisi per i nuovi messaggi"
        case .alertsBody: return "La schermata di blocco mostra chi ha scritto, mai cosa."
        case .alertsTurnOn: return "Attiva gli avvisi"
        case .alertsNotNow: return "Non ora"
        case .alertsOffStrip: return "Gli avvisi sono spenti. Perderai dei messaggi."
        case .alertsOpenSettings: return "Apri Impostazioni di iPhone"
        case .youTitle: return "Tu"
        case .signOut: return "Esci"
        case .signedOutSheet: return "Sei stato disconnesso. Accedi per continuare. I messaggi non inviati sono conservati."
        }
    }
}
