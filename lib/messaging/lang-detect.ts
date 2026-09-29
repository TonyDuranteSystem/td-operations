/**
 * A cheap, LOCAL guess at whether a short chat message is Italian or English — used only to pre-select the
 * language dropdown before a WhatsApp send (the staff member can always change it; a rewrite through the AI
 * worker is what actually changes the text). Never a source of truth for anything client-facing on its own.
 *
 * Deliberately simple: counts common, unambiguous Italian and English stopwords/markers. No network call, no
 * AI — this only sets which option is pre-selected in a dropdown, so a cheap heuristic is enough and it must
 * never throw on weird input (emoji-only text, numbers, empty string).
 */

const ITALIAN_MARKERS = [
  "ciao", "grazie", "prego", "buongiorno", "buonasera", "salve", "cordiali", "saluti", "gentile", "cortesemente",
  "perché", "quando", "dove", "come", "che", "questo", "questa", "sono", "siamo", "hai", "abbiamo", "posso",
  "vorrei", "potrebbe", "scusa", "scusi", "domani", "oggi", "ieri", "grazie", "cortese", "gentilmente",
]
const ENGLISH_MARKERS = [
  "hello", "hi", "thanks", "thank", "please", "regards", "sincerely", "dear", "would", "could", "should",
  "the", "and", "you", "your", "we", "our", "today", "tomorrow", "yesterday", "sorry", "kindly", "best",
]

function countHits(words: string[], markers: string[]): number {
  const set = new Set(markers)
  let n = 0
  for (const w of words) if (set.has(w)) n++
  return n
}

/** Returns 'it' or 'en' when reasonably confident, otherwise null (caller should fall back to a stored preference). */
export function guessMessageLocale(text: string | null | undefined): "it" | "en" | null {
  if (typeof text !== "string") return null
  const words = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents so "perché"/"perche" both match
    .match(/[a-z']+/g)
  if (!words || words.length === 0) return null

  const it = countHits(words, ITALIAN_MARKERS)
  const en = countHits(words, ENGLISH_MARKERS)
  if (it === 0 && en === 0) return null
  if (it === en) return null
  return it > en ? "it" : "en"
}
