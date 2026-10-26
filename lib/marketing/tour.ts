/**
 * TD Marketing — the guided tour (pure; dev job 9aec66fa). Each person gets a short walk through the screens THEY have: what each is for and what to do there. The text is data, in English and
 * Italian, per role; which tour a person gets and which steps are shown come from their exact permissions (so a person whose access was changed never sees a step for a screen they do not have).
 * No database and no DOM here: the screen, the spotlight and the "seen" mark are in components/marketing/tour.tsx and lib/marketing/tour-seen.ts.
 */
import { describeAccess, type Bundles } from "@/lib/marketing/access"
import { modulesFor } from "@/lib/marketing/workspace"
import type { Lang } from "@/lib/marketing/templates"

export type TourKey = "owner" | "setter" | "seller" | "analyst" | "content" | "generic"
/** The tours an owner can preview from the Team screen (the roles he hands out). */
export const PREVIEW_TOURS: readonly TourKey[] = ["setter", "seller", "content", "analyst"]
export const TOUR_KEYS: readonly TourKey[] = ["owner", "setter", "seller", "analyst", "content", "generic"]

export interface TourStep {
  /** the workspace screen (a key of `modulesFor`) the step is on */
  screen: string
  /** what to point at: a key of TARGETS */
  target: string
  en: { title: string; body: string }
  it: { title: string; body: string }
  /** added to the body for the OWNER's tour only (it talks about things only an owner has on screen) */
  ownerNote?: { en: string; it: string }
}

/** What each target points at, most precise first; the first one found on the screen is lit. When none exists (an empty screen) the page heading is used, and when even that is missing the card sits in the middle. */
export const TARGETS: Record<string, readonly string[]> = {
  cards: ['[data-testid="board-card"]', '[data-testid="cards"]', "h1"],
  strip: ['[data-testid="stage-strip"]', "h1"],
  tabs: ['[data-testid="cal-area"]', '[data-testid="cal-title"]', "h1"],
  composer: ['[data-testid="talk-input"]', '[data-testid="chat-workspace"]', "h1"],
  list: ['[data-testid="tpl-row"]', "h1"],
  invite: ['[data-testid="open-invite"]', "h1"],
  tbl: ["table", "h1"],
  queue: ['[data-testid="queue"]', "h1"],
  result: ['[data-testid="lead-result"]', '[data-testid="queue"]', "h1"],
  pick: ['[data-testid="today-summary"]', "h1"],
  tiles: ['[data-testid="worked"]', "h1"],
  byad: ["h2", "h1"],
}

const STEPS: Record<Exclude<TourKey, "generic">, TourStep[]> = {
  owner: [
    { screen: "board", target: "cards",
      en: { title: "Board: every lead of the team", body: "Each column is a step of the road from \"New\" to a sale. Each card is a lead. Click a card and the lead opens in a window on top of whatever you are doing (up to three at once)." },
      it: { title: "Bacheca: ogni lead del team", body: "Ogni colonna è un passo del percorso da \"Nuovo\" fino alla vendita. Ogni scheda è un lead. Clicca una scheda e il lead si apre in una finestra sopra a quello che stai facendo (fino a tre insieme)." } },
    { screen: "leads", target: "strip",
      en: { title: "Leads: find anyone", body: "The numbers on top count the leads in each step. Use the search box to find a name, a phone or an ad. You see all the leads of the team, not only your own." },
      it: { title: "Lead: trova chiunque", body: "I numeri in alto contano i lead di ogni passo. Usa la ricerca per trovare un nome, un telefono o un'inserzione. Vedi tutti i lead del team, non solo i tuoi." } },
    { screen: "calendar", target: "tabs",
      en: { title: "Calendar: the calls that are coming", body: "Day, Week, Month or Pipeline (Late, Today, Tomorrow, This week, Later). Drag a call to another day or time to move it. You must write a reason, and the person who set the call is told." },
      it: { title: "Calendario: le chiamate in arrivo", body: "Giorno, Settimana, Mese o Pipeline (In ritardo, Oggi, Domani, Questa settimana, Dopo). Trascina una chiamata su un altro giorno o ora per spostarla. Devi scrivere il motivo e chi ha fissato la chiamata viene avvisato." } },
    { screen: "chat", target: "composer",
      en: { title: "Chat: talk to the team and about a lead", body: "Every lead has its own chat. You can also write directly to a person or start a group. Type @ and pick a name to call someone, even Antonio: he gets a notice. A red number in the menu shows what is waiting for you." },
      it: { title: "Chat: parla col team e sui lead", body: "Ogni lead ha la sua chat. Puoi anche scrivere a una persona o creare un gruppo. Scrivi @ e scegli un nome per chiamare qualcuno, anche Antonio: riceve un avviso. Un numero rosso nel menu mostra cosa ti aspetta." } },
    { screen: "templates", target: "list",
      en: { title: "Templates: ready-made messages", body: "Only you (the owner) create and edit them. Everybody on the team uses them with one click and the lead's name is filled in. From a lead, \"Save as template\" turns a good message into a template." },
      it: { title: "Modelli: messaggi pronti", body: "Solo tu (il titolare) li crei e li modifichi. Tutti nel team li usano con un clic e il nome del lead si compila da solo. Da un lead, \"Salva come modello\" trasforma un buon messaggio in un modello." } },
    { screen: "team", target: "invite",
      en: { title: "Team: invite people and choose what they see", body: "Write an email, pick the role (setter, seller, ad person, analyst) and you get a one-time link, or send the invitation by email. \"Change access\" decides which screens each person has. You can pause or remove a person at once." },
      it: { title: "Team: invita le persone e scegli cosa vedono", body: "Scrivi un'email, scegli il ruolo (setter, seller, persona degli annunci, analyst) e ottieni un link monouso, oppure invia l'invito per email. \"Cambia accessi\" decide quali schermate ha ognuno. Puoi sospendere o togliere una persona subito." },
      ownerNote: { en: "Below, \"See each role's tour\" shows you what each person is shown.", it: "Sotto, \"Vedi il giro di ogni ruolo\" ti mostra cosa vede ogni persona." } },
    { screen: "money", target: "tbl",
      en: { title: "Money: what the sales brought", body: "Payment links for the sales and what was paid by the leads of your team. Only people you give this screen to can see it." },
      it: { title: "Soldi: cosa hanno portato le vendite", body: "I link di pagamento per le vendite e ciò che hanno pagato i lead del tuo team. Solo le persone a cui dai questa schermata la vedono." } },
  ],
  setter: [
    { screen: "call-list", target: "queue",
      en: { title: "Call list: your work for today", body: "At the top, the call backs that are due (the late ones first). Under them, the new leads nobody has called, the oldest first. Work from the top down." },
      it: { title: "Lista chiamate: il tuo lavoro di oggi", body: "In alto le richiamate in scadenza (prima quelle in ritardo). Sotto, i lead nuovi che nessuno ha chiamato, dal più vecchio. Lavora dall'alto verso il basso." } },
    { screen: "call-list", target: "result",
      en: { title: "After the call: say how it went", body: "Open the lead and press the result: **Good** (worth a seller), **Not in target** (pick a reason) or **Call back later** (pick a day and time). **Pass to Rocco** hands the lead over with a note, and **Book Rocco's call** fixes a day and time with him." },
      it: { title: "Dopo la chiamata: dì com'è andata", body: "Apri il lead e premi il risultato: **Buono** (vale per un seller), **Fuori target** (scegli il motivo) o **Richiama più tardi** (scegli giorno e ora). **Passa a Rocco** gli dà il lead con una nota e **Fissa la chiamata con Rocco** sceglie un giorno e un'ora con lui." } },
    { screen: "calendar", target: "tabs",
      en: { title: "Calendar: your call backs", body: "Your call backs are here, by day. Drag one to move it; you must write why. The calendar shows YOUR calls only." },
      it: { title: "Calendario: le tue richiamate", body: "Le tue richiamate sono qui, per giorno. Trascinane una per spostarla; devi scrivere il motivo. Il calendario mostra solo le TUE chiamate." } },
    { screen: "chat", target: "composer",
      en: { title: "Chat: ask for help on a lead", body: "Each lead has a chat with the team. Write there instead of WhatsApp, so the answer stays with the lead. Type @ to call a person." },
      it: { title: "Chat: chiedi aiuto su un lead", body: "Ogni lead ha una chat col team. Scrivi lì invece che su WhatsApp, così la risposta resta col lead. Scrivi @ per chiamare una persona." } },
    { screen: "templates", target: "list",
      en: { title: "Templates: do not retype", body: "Pick a template, the lead's name is filled in, copy the message and send it. The owner keeps the templates." },
      it: { title: "Modelli: non riscrivere", body: "Scegli un modello, il nome del lead si compila, copia il messaggio e invialo. I modelli li gestisce il titolare." } },
    { screen: "my-numbers", target: "tiles",
      en: { title: "My numbers: how you are doing", body: "How many leads you marked, how many Good, your Good rate and how many of your Good leads paid a call. Only you see your numbers (and the owner)." },
      it: { title: "I miei numeri: come stai andando", body: "Quanti lead hai segnato, quanti Buoni, la tua percentuale di Buoni e quanti dei tuoi Buoni hanno pagato una chiamata. Li vedi solo tu (e il titolare)." } },
  ],
  seller: [
    { screen: "today", target: "pick",
      en: { title: "Today: what needs you now", body: "Call backs due, Good leads waiting for a seller, and new leads waiting too long. Press **Pick this lead** on a Good lead: it becomes yours and leaves everybody else's list." },
      it: { title: "Oggi: cosa ti serve ora", body: "Richiamate in scadenza, lead Buoni che aspettano un seller e lead nuovi in attesa da troppo. Premi **Prendi questo lead** su un lead Buono: diventa tuo e sparisce dalla lista degli altri." } },
    { screen: "board", target: "cards",
      en: { title: "Board: your leads in six columns", body: "**Booked calls**: the calls the setter fixed for you, the soonest first. A call stays here after it has happened, until you press its result. After the call, open the lead and press one result: **Not in target** (not a fit for us), **Not ready now** (pick the day to come back: the lead returns then, even in six months), **Closed** (the sale is agreed) or **Not closed** (no sale). **Paid** fills by itself when the client pays your payment link; a Closed lead that pays moves to Paid. The payment link is short: create it on the lead, copy it and send it." },
      it: { title: "Bacheca: i tuoi lead in sei colonne", body: "**Chiamate fissate**: le chiamate che il setter ha fissato per te, la più vicina per prima. Una chiamata resta qui anche dopo che è avvenuta, finché non premi il suo risultato. Dopo la chiamata apri il lead e premi un risultato: **Fuori target** (non fa per noi), **Non pronto ora** (scegli il giorno in cui riprendere: il lead torna quel giorno, anche tra sei mesi), **Chiuso** (la vendita è conclusa) o **Non chiuso** (nessuna vendita). **Pagato** si riempie da solo quando il cliente paga il tuo link di pagamento; un lead Chiuso che paga passa a Pagato. Il link di pagamento è corto: crealo sul lead, copialo e invialo." } },
    { screen: "calendar", target: "tabs",
      en: { title: "Calendar: your calls", body: "Your booked calls and call backs by day. Drag to move, with a reason. The person who set the call is told." },
      it: { title: "Calendario: le tue chiamate", body: "Le tue chiamate fissate e richiamate per giorno. Trascina per spostare, con un motivo. Chi ha fissato la chiamata viene avvisato." } },
    { screen: "chat", target: "composer",
      en: { title: "Chat: the lead and the team", body: "Read what the setter wrote about the lead before you call. Ask questions there. Type @ to call a person." },
      it: { title: "Chat: il lead e il team", body: "Leggi cosa ha scritto il setter sul lead prima di chiamare. Fai domande lì. Scrivi @ per chiamare una persona." } },
    { screen: "templates", target: "list",
      en: { title: "Templates: ready-made messages", body: "Use them for the first message, the reminder, the follow-up. The lead's name is filled in for you." },
      it: { title: "Modelli: messaggi pronti", body: "Usali per il primo messaggio, il promemoria, il seguito. Il nome del lead si compila da solo." } },
    { screen: "reports", target: "byad",
      en: { title: "Reports: what works", body: "Which ads bring leads that become sales, and why leads were not in target. Use it to see where your time pays." },
      it: { title: "Report: cosa funziona", body: "Quali annunci portano lead che diventano vendite e perché i lead erano fuori target. Serve a capire dove rende il tuo tempo." } },
  ],
  analyst: [
    { screen: "board", target: "cards",
      en: { title: "Board: look, do not touch", body: "You see every lead and its step. You can open a lead and read it. You cannot change anything: your access is read only." },
      it: { title: "Bacheca: guardi, non tocchi", body: "Vedi ogni lead e il suo passo. Puoi aprire un lead e leggerlo. Non puoi cambiare nulla: il tuo accesso è solo lettura." } },
    { screen: "activity", target: "tbl",
      en: { title: "Team activity: who did what", body: "For each person: leads worked, results marked, how fast they answer. Use it to see where leads wait." },
      it: { title: "Attività del team: chi ha fatto cosa", body: "Per ogni persona: lead lavorati, risultati segnati, quanto in fretta rispondono. Serve a vedere dove i lead aspettano." } },
    { screen: "calendar", target: "tabs",
      en: { title: "Calendar: everyone's calls", body: "You see the calls of the whole team and can pick whose calendar to look at." },
      it: { title: "Calendario: le chiamate di tutti", body: "Vedi le chiamate di tutto il team e puoi scegliere di chi guardare il calendario." } },
    { screen: "reports", target: "byad",
      en: { title: "Reports: ads and reasons", body: "Leads by ad with how many became Good and paid, and the reasons for \"Not in target\". This is the main screen for your analysis." },
      it: { title: "Report: annunci e motivi", body: "Lead per annuncio con quanti sono diventati Buoni e hanno pagato, e i motivi di \"Fuori target\". È la schermata principale per le tue analisi." } },
  ],
  content: [
    { screen: "board", target: "cards",
      en: { title: "Board: the leads your ads bring", body: "You see the leads and the step each one has reached. You can read them, not change them. Phone numbers are not shown to you." },
      it: { title: "Bacheca: i lead che portano le tue inserzioni", body: "Vedi i lead e il passo a cui sono arrivati. Puoi leggerli, non cambiarli. I numeri di telefono non ti vengono mostrati." } },
    { screen: "reports", target: "byad",
      en: { title: "Reports: which ads work", body: "Leads by ad, how many were Good and how many paid, plus why leads were not in target. This tells you which ads to repeat and which to stop." },
      it: { title: "Report: quali annunci funzionano", body: "Lead per annuncio, quanti Buoni e quanti hanno pagato, più i motivi dei lead fuori target. Ti dice quali annunci ripetere e quali fermare." } },
    { screen: "chat", target: "composer",
      en: { title: "Chat: talk to the team", body: "Tell the team about a new ad or a change, and ask what leads say. Type @ to call a person." },
      it: { title: "Chat: parla col team", body: "Avvisa il team di un nuovo annuncio o di un cambio e chiedi cosa dicono i lead. Scrivi @ per chiamare una persona." } },
  ],
}

export const WELCOME: Record<Lang, { title: string; body: string; start: string; skip: string }> = {
  en: { title: "Welcome to TD Marketing", body: "This is the team's workspace. Leads from the ads arrive here on their own. The team works them, step by step, until they become a sale. This short tour shows only the screens YOU have. It takes about two minutes, and you can open it again any time from the Tour button at the bottom left.", start: "Start the tour", skip: "Skip" },
  it: { title: "Benvenuto in TD Marketing", body: "Questo è lo spazio di lavoro del team. I lead dalle inserzioni arrivano qui da soli. Il team li lavora, passo dopo passo, fino alla vendita. Questo breve giro mostra solo le schermate CHE HAI TU. Dura circa due minuti e puoi riaprirlo quando vuoi dal pulsante Tour in basso a sinistra.", start: "Inizia il giro", skip: "Salta" },
}
export const DONE: Record<Lang, { title: string; body: string; close: string }> = {
  en: { title: "You are ready", body: "The tour is finished. Open it again any time with the Tour button (bottom left). If something is not clear, ask in Chat: Rocco and Antonio read it.", close: "Close" },
  it: { title: "Sei pronto", body: "Il giro è finito. Riaprilo quando vuoi con il pulsante Tour (in basso a sinistra). Se qualcosa non è chiaro, chiedi in Chat: Rocco e Antonio la leggono.", close: "Chiudi" },
}

/** The tours that are tried, in this order, for a person whose access looks like several roles. */
const ROLE_ORDER: readonly Exclude<TourKey, "owner" | "generic">[] = ["seller", "setter", "analyst", "content"]

/**
 * Which tour a person gets: the owner's, or the one of the role his exact access still looks like (`describeAccess`, the same rule the Team page uses). A person whose access matches no known role
 * (custom ticks) gets the generic tour, built from the screens he has.
 */
export function tourKeyFor(input: { memberRole: "owner" | "member"; permissions: readonly string[]; bundles: Bundles }): TourKey {
  if (input.memberRole === "owner") return "owner"
  const roles = describeAccess(input.permissions, input.bundles).roles
  for (const r of ROLE_ORDER) if (roles.includes(r)) return r
  return "generic"
}

/** The steps of a tour, only on screens this person has (an owner previewing a role's tour has every screen). The generic tour takes the first step of each screen the person has, from the role tours. */
export function stepsFor(key: TourKey, permissions: readonly string[]): TourStep[] {
  const have = new Set(modulesFor(permissions).filter(m => m.built).map(m => m.key))
  if (key !== "generic") return STEPS[key].filter(s => have.has(s.screen))
  const seen = new Set<string>()
  const out: TourStep[] = []
  for (const k of ["setter", "seller", "content", "analyst", "owner"] as const) {
    for (const s of STEPS[k]) {
      if (!have.has(s.screen) || seen.has(s.screen)) continue
      seen.add(s.screen)
      out.push(s)
    }
  }
  return out
}

export interface ResolvedStep { screen: string; href: string; target: string; title: string; body: string }

/** A tour ready for the screen: the person's language, the address of each step's screen. */
export function resolveTour(key: TourKey, permissions: readonly string[], lang: Lang): ResolvedStep[] {
  const hrefs = new Map(modulesFor(permissions).map(m => [m.key, m.href]))
  return stepsFor(key, permissions).map(s => ({ screen: s.screen, href: hrefs.get(s.screen) ?? "/marketing", target: s.target, title: s[lang].title, body: key === "owner" && s.ownerNote ? `${s[lang].body} ${s.ownerNote[lang]}` : s[lang].body }))
}

/** A line with **bold** parts into pieces, so the screen can show bold without ever inserting raw HTML. */
export function boldParts(text: string): Array<{ text: string; bold: boolean }> {
  return text.split("**").map((t, i) => ({ text: t, bold: i % 2 === 1 })).filter(p => p.text !== "")
}

export const isTourKey = (v: unknown): v is TourKey => typeof v === "string" && (TOUR_KEYS as readonly string[]).includes(v)
