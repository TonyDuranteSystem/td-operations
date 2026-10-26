/**
 * The messages the team sends, by topic (pure; TD Marketing, dev job 9aec66fa). The defaults live HERE, in Italian and English, so they exist from day one with no database
 * step; a team can override any of them by key in the `message_templates` setting (the setting wins). Placeholders: {name} (first name), {setter} (who writes), {when} (the booked call).
 * `whatsappLink` makes the wa.me address that opens WhatsApp with the message already typed — it never sends anything: the person presses Send, then records it.
 */
export type Lang = "it" | "en"
export interface TemplateDef { key: string; label: Record<Lang, string>; text: Record<Lang, string> }

export const DEFAULT_TEMPLATES: readonly TemplateDef[] = [
  {
    key: "first_contact", label: { it: "Primo contatto", en: "First contact" },
    text: {
      it: "Buongiorno {name}, sono {setter}, collaboratrice di Tony Durante e Rocco 👋\nLa contatto in seguito alla sua richiesta di informazioni sui nostri servizi dedicati alle attività imprenditoriali e societarie negli Stati Uniti.\nPrima di proporle un eventuale appuntamento telefonico con un nostro consulente, vorrei comprendere meglio la sua esigenza, così da capire come possiamo esserle concretamente utili.\nPosso chiederle se ha già una società negli USA oppure se sta valutando di aprirne una?\nLa ringrazio e resto a disposizione.",
      en: "Hello {name}, this is {setter}, working with Tony Durante and Rocco 👋\nI'm contacting you about your request for information on our services for business and company matters in the United States.\nBefore proposing a phone call with one of our consultants, I'd like to understand your needs better, so we can be truly useful to you.\nMay I ask whether you already have a company in the USA, or are thinking of opening one?\nThank you, I remain at your disposal.",
    },
  },
  {
    key: "no_answer", label: { it: "Nessuna risposta (secondo messaggio)", en: "No answer (second message)" },
    text: {
      it: "Buongiorno {name}, sono {setter} di Tony Durante. Le avevo scritto riguardo alla sua richiesta sui servizi per la società negli Stati Uniti. Quando le è comodo, mi dica pure un giorno e un orario e la richiamo volentieri. Grazie!",
      en: "Hello {name}, this is {setter} from Tony Durante. I wrote to you about your request on our US company services. Whenever it suits you, tell me a day and time and I'll gladly call you back. Thank you!",
    },
  },
  {
    key: "questionnaire", label: { it: "Domande veloci", en: "A few quick questions" },
    text: {
      it: "Buongiorno {name}, per prepararle una proposta su misura mi servono tre informazioni: 1) che attività ha, 2) dove risiede oggi, 3) entro quando vorrebbe partire. Mi basta una breve risposta qui. Grazie, {setter}",
      en: "Hello {name}, to prepare a tailored proposal I need three things: 1) what business you run, 2) where you live today, 3) when you'd like to start. A short reply here is enough. Thank you, {setter}",
    },
  },
  {
    key: "appointment_confirm", label: { it: "Conferma appuntamento", en: "Appointment confirmation" },
    text: {
      it: "Buongiorno {name}, le confermo la telefonata con il nostro consulente: {when}. La chiameremo noi. Se deve spostarla, mi scriva pure qui. A presto, {setter}",
      en: "Hello {name}, I confirm your call with our consultant: {when}. We will call you. If you need to move it, just write to me here. See you soon, {setter}",
    },
  },
  {
    key: "appointment_reminder", label: { it: "Promemoria (giorno prima)", en: "Reminder (day before)" },
    text: {
      it: "Buongiorno {name}, le ricordo la telefonata di domani con il nostro consulente: {when}. Ci sarà? Grazie, {setter}",
      en: "Hello {name}, a reminder of tomorrow's call with our consultant: {when}. Will you be available? Thank you, {setter}",
    },
  },
  {
    key: "material", label: { it: "Invio materiale", en: "Sending material" },
    text: {
      it: "Buongiorno {name}, come promesso le invio il materiale informativo sui nostri servizi. Lo guardi con calma e, se ha domande, scriva pure qui. {setter}",
      en: "Hello {name}, as promised I'm sending you the information material on our services. Take your time, and if you have questions just write here. {setter}",
    },
  },
  {
    key: "nurture", label: { it: "Ricontatto più avanti", en: "Follow up later" },
    text: {
      it: "Buongiorno {name}, spero stia bene. Mi ero ripromessa di risentirla: se oggi è un buon momento per riparlare della sua società negli Stati Uniti, ne sarei felice. {setter}",
      en: "Hello {name}, I hope you're well. I promised to get back to you: if now is a good time to talk again about your US company, I'd be glad to. {setter}",
    },
  },
]

/** What the owner changed on one template (a field left out = the built-in wording; for a template the owner created, `label` and one text are required). */
export interface TemplateEdit { label?: string; it?: string; en?: string }
export type TeamTemplates = Record<string, TemplateEdit>

export interface TemplateView { key: string; label: string; text: string }
/** One row of the Templates screen: both languages, and where the template comes from. */
export interface TemplateRow { key: string; label: string; it: string; en: string; builtIn: boolean; edited: boolean }

const other = (l: Lang): Lang => (l === "it" ? "en" : "it")

/**
 * The templates in one language: the built-in ones, with the team's own wording winning (the owner's `team_templates` first, then the older single-text `message_templates`), then the templates
 * the owner created. A template with a text in only one language is shown in that language to everyone (better a message in the other language than none).
 */
export function templatesFor(lang: Lang, overrides: Record<string, string> = {}, custom: TeamTemplates = {}): TemplateView[] {
  const out: TemplateView[] = DEFAULT_TEMPLATES.map(t => {
    const c = custom[t.key]
    return { key: t.key, label: c?.label || t.label[lang], text: c?.[lang] || overrides[t.key] || t.text[lang] }
  })
  for (const [k, c] of Object.entries(custom)) {
    if (DEFAULT_TEMPLATES.some(t => t.key === k)) continue
    const text = c[lang] || c[other(lang)] || ""
    if (text) out.push({ key: k, label: c.label || k, text })
  }
  // the older setting could still hold a key nobody has built in
  for (const [k, v] of Object.entries(overrides)) if (!out.some(t => t.key === k)) out.push({ key: k, label: k, text: v })
  return out
}

/** The rows of the Templates screen: both languages of every template. */
export function templateRows(overrides: Record<string, string> = {}, custom: TeamTemplates = {}, lang: Lang = "en"): TemplateRow[] {
  const rows: TemplateRow[] = DEFAULT_TEMPLATES.map(t => {
    const c = custom[t.key]
    return { key: t.key, label: c?.label || t.label[lang], it: c?.it || overrides[t.key] || t.text.it, en: c?.en || overrides[t.key] || t.text.en, builtIn: true, edited: !!(c && (c.label || c.it || c.en)) || t.key in overrides }
  })
  for (const [k, c] of Object.entries(custom)) {
    if (DEFAULT_TEMPLATES.some(t => t.key === k)) continue
    rows.push({ key: k, label: c.label || k, it: c.it ?? "", en: c.en ?? "", builtIn: false, edited: false })
  }
  return rows
}

const KNOWN_PLACEHOLDERS = ["name", "setter", "when"]
/** The first {word} in a text that is not a placeholder the system fills in (or a doubled brace like {{name}}), or null. */
export function unknownPlaceholder(text: string): string | null {
  const doubled = /\{\{[^{}]*\}?\}?/.exec(text)
  if (doubled) return doubled[0]
  const re = /\{([^{}]*)\}/g
  for (let m = re.exec(text); m !== null; m = re.exec(text)) if (!KNOWN_PLACEHOLDERS.includes(m[1])) return m[1]
  return null
}

/**
 * A message as typed in the lead's box has THIS lead's first name, THIS setter's name and THIS call time in it. Saved as a template those must go back to {name} {setter} {when}, or the
 * template would greet every lead as Marco. Only whole words are replaced, and only names of 2 letters or more.
 */
export function unfillTemplate(text: string, v: { name?: string | null; setter?: string | null; when?: string | null }, original = ""): string {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const word = (w: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(w)}(?![\\p{L}\\p{N}])`, "iu")
  const same = (v.name ?? "").trim().toLowerCase() !== "" && (v.name ?? "").trim().toLowerCase() === (v.setter ?? "").trim().toLowerCase()
  let out = text
  for (const [value, token] of [[v.when, "{when}"], [v.setter, "{setter}"], [v.name, "{name}"]] as const) {
    const w = (value ?? "").trim()
    if (w.length < 2) continue
    // a name that is part of the template's own fixed wording ("…Tony Durante and Rocco") is wording, not a placeholder; and when the lead and the setter share a name there is no telling which is which
    if (original && word(w).test(original)) continue
    if (same && token !== "{when}") continue
    out = out.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${esc(w)}(?![\\p{L}\\p{N}])`, "gu"), `$1${token}`)
  }
  return out
}

/** "Mario Rossi" -> "Mario"; "Rossi, Mario" is left alone; an empty name -> "" so the greeting stays natural. */
export function firstName(full: string | null | undefined): string {
  const f = (full ?? "").trim().split(/\s+/)[0] ?? ""
  return f.length > 40 ? f.slice(0, 40) : f
}

/** Fill {name} {setter} {when}; a placeholder with no value becomes empty, a stray double space/comma-space is tidied. */
export function fillTemplate(text: string, v: { name?: string | null; setter?: string | null; when?: string | null }): string {
  return text.replace(/\{name\}/g, v.name ?? "").replace(/\{setter\}/g, v.setter ?? "").replace(/\{when\}/g, v.when ?? "")
    .replace(/[ \t]{2,}/g, " ").replace(/ ([,.!?])/g, "$1").replace(/Buongiorno ,/g, "Buongiorno,").replace(/Hello ,/g, "Hello,")
}

/** The digits WhatsApp wants for a phone number ("+39 333 111 2233", "0039 333…" -> 393331112233); null when the number is not usable. */
function whatsappDigits(phone: string | null | undefined): string | null {
  let d = (phone ?? "").replace(/[^\d]/g, "")
  if ((phone ?? "").trim().startsWith("00") || d.startsWith("00")) d = d.replace(/^00/, "")
  return d.length < 8 || d.length > 15 ? null : d
}

/** wa.me address for a phone number with the text typed in; null when the number is not usable. */
export function whatsappLink(phone: string | null | undefined, text: string): string | null {
  const d = whatsappDigits(phone)
  return d ? `https://wa.me/${d}?text=${encodeURIComponent(text)}` : null
}

/** The WhatsApp Web address that opens straight on that person's chat with the text written (the person still presses Send); null when the number is not usable. */
export function whatsappWebLink(phone: string | null | undefined, text: string): string | null {
  const d = whatsappDigits(phone)
  return d ? `https://web.whatsapp.com/send?phone=${d}&text=${encodeURIComponent(text)}` : null
}

/**
 * Whose name the opening message is signed with: the SETTER of this lead — never whoever happens to be looking at the page. In order: the person who picked the lead; else the person who last
 * worked it as a setter (sent the WhatsApp, tried a call, picked it), Antonio's "View as" rows ignored; else the viewer, unless the viewer is Antonio looking in as someone else
 * (then nothing: a blank signature is better than his name on a message to a lead).
 */
export function messageSigner(i: {
  claimedLabel: string | null
  events: ReadonlyArray<{ kind: string; actor: string; created_at: string; data?: Record<string, unknown> | null }>
  viewerName: string
  viewingAs: boolean
  nameOf: (actor: string) => string
}): string {
  if (i.claimedLabel) return i.nameOf(i.claimedLabel)
  const setterKinds = new Set(["whatsapp", "attempt", "claimed"])
  const mine = i.events.filter(e => setterKinds.has(e.kind) && e.actor && e.actor !== "system" && e.data?.via_view_as !== true).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
  if (mine) return i.nameOf(mine.actor)
  return i.viewingAs ? "" : i.viewerName
}
