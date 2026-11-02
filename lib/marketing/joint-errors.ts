/** TD Marketing — the client page of the booking link WITH the owner: Italian for the refusals the server writes in English (pure, no imports, safe in the browser). The sentences must match joint-rules.ts and joint-booking.ts exactly; a test checks it. */
type Lang = "it" | "en"

/** Every sentence the client's page can show as a refusal, in Italian (the server writes them in English). A sentence that is not here is shown as written. */
const ERRORS_IT: Record<string, string> = {
  "This link cannot be used any more. Ask the person who sent it for a new one.": "Questo link non è più valido. Chiedi un nuovo link a chi te lo ha inviato.",
  "That time was just taken. Please choose another one.": "Quell'orario è stato appena occupato. Scegline un altro.",
  "Check your name, your email and the time you chose.": "Controlla il tuo nome, la tua email e l'orario scelto.",
  "Choose a time.": "Scegli un orario.",
  "Times cannot be shown right now. Please try again in a few minutes.": "Gli orari non sono disponibili in questo momento. Riprova tra qualche minuto.",
  "The booking could not be saved. Please try again.": "Non siamo riusciti a salvare la prenotazione. Riprova.",
  "The booking could not be finished. Please try again.": "Non siamo riusciti a completare la prenotazione. Riprova.",
  "The video call could not be created. Please try again in a few minutes.": "Non siamo riusciti a creare la videochiamata. Riprova tra qualche minuto.",
  "The change could not be saved. Please try again.": "Non siamo riusciti a salvare la modifica. Riprova.",
  "The change could not be finished. Please try again.": "Non siamo riusciti a completare la modifica. Riprova.",
  "Something went wrong. Please try again in a moment.": "Qualcosa è andato storto. Riprova tra un momento.",
}
export const jointErrorKeys = (): string[] => Object.keys(ERRORS_IT)
export function jointErrorText(error: string, lang: Lang): string { return lang === "it" ? (ERRORS_IT[error] ?? error) : error }
