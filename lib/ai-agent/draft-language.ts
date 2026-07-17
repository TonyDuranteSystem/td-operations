/**
 * Conservative EN/IT draft-language detection for the worker's client-send
 * language guard (Adam Marra incident, 2026-07-17: an English draft was sent to
 * an Italian-language client — the prompt rule alone failed for the second
 * time, so the floor is now code).
 *
 * Design contract (council-approved):
 * - FAIL-OPEN. "unknown" unless the text is confidently one language: short
 *   drafts ("si", "Ok perfetto — Suite 3D-308"), mixed drafts, and
 *   address/name-heavy text must NOT trip the guard.
 * - Pure and dependency-free so it's trivially unit-testable.
 * - The guard direction is ONLY Italian-client + confidently-English draft;
 *   the CONTACT side of the comparison uses lib/locale.ts (the canonical
 *   contacts.language normalizer), not this module.
 */

export type DraftLanguage = "it" | "en" | "unknown"

// Function words only — proper nouns, addresses, and product terms ("Suite",
// "Interactive Brokers", "Sign Documents") intentionally carry no signal.
const IT_SIGNAL = new Set([
  "il", "lo", "la", "gli", "le", "un", "una", "uno", "di", "del", "della", "dei", "delle", "nel", "nella",
  "che", "per", "con", "sul", "sulla", "come", "anche", "già", "dove", "quando", "perché", "però",
  "questo", "questa", "questi", "queste", "quello", "quella",
  "sono", "sei", "è", "siamo", "siete", "hanno", "ha", "ho", "hai", "abbiamo", "avete",
  "sarà", "sarai", "sarebbe", "puoi", "può", "possiamo", "potete", "devi", "deve", "dovrai", "dovremo",
  "fare", "fatto", "fatta", "stato", "stata", "essere", "avere",
  "ti", "mi", "ci", "vi", "si", "tuo", "tua", "tuoi", "tue", "suo", "sua", "nostro", "nostra", "vostro",
  "ciao", "buongiorno", "buonasera", "grazie", "prego", "gentile", "cordiali", "saluti",
  "non", "più", "molto", "tutto", "tutti", "ancora", "quindi", "inoltre", "dopo", "prima",
  "qualsiasi", "ogni", "alcuni", "appena", "possibile", "bisogno", "chiediamo", "trovi", "sezione",
  "firmare", "firmato", "caricare", "caricato", "inviare", "inviato", "aggiorna", "aggiornare",
  "documento", "documenti", "messaggio", "indirizzo", "contratto", "disposizione", "domanda", "volta",
])

const EN_SIGNAL = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "with", "and", "or", "but", "at", "by", "from",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does", "did",
  "will", "would", "can", "could", "should", "shall", "may", "might", "must",
  "you", "your", "yours", "we", "our", "ours", "they", "their", "it", "its", "he", "she", "him", "her",
  "this", "that", "these", "those", "there", "here", "what", "which", "when", "where", "how", "why",
  "please", "thanks", "thank", "hello", "hi", "dear", "regards", "sincerely",
  "not", "no", "yes", "also", "just", "once", "then", "after", "before", "any", "all", "some", "more",
  "need", "needs", "needed", "upload", "uploaded", "sign", "signed", "send", "sent", "change", "changed",
  "find", "found", "know", "let", "us", "if", "as", "so", "one", "two", "new", "next",
])

/** Minimum recognized-signal words before we dare classify at all. */
const MIN_SIGNAL_TOKENS = 5
/** Minimum total words — very short drafts are never classified. */
const MIN_TOTAL_TOKENS = 12
/** Winner must have at least this multiple of the loser, plus a margin. */
const DOMINANCE_RATIO = 2
const DOMINANCE_MARGIN = 2

/**
 * Classify a client-facing draft as Italian, English, or unknown.
 * Conservative by contract: when unsure, return "unknown" (the guard then
 * allows the send).
 */
export function detectDraftLanguage(text: string | null | undefined): DraftLanguage {
  if (!text) return "unknown"
  // Words only (ASCII + Latin-1 accented letters cover EN + IT); URLs, numbers,
  // punctuation drop out. Explicit class instead of \p{L} — the build toolchain
  // rejects Unicode property escapes.
  const tokens = (text.toLowerCase().match(/[a-zÀ-ÿ']+/g) ?? []).map((t) => t.replace(/^'+|'+$/g, ""))
  if (tokens.length < MIN_TOTAL_TOKENS) return "unknown"

  let it = 0
  let en = 0
  for (const t of tokens) {
    if (IT_SIGNAL.has(t)) it++
    if (EN_SIGNAL.has(t)) en++
  }
  if (it + en < MIN_SIGNAL_TOKENS) return "unknown"
  if (it >= en * DOMINANCE_RATIO + DOMINANCE_MARGIN) return "it"
  if (en >= it * DOMINANCE_RATIO + DOMINANCE_MARGIN) return "en"
  return "unknown"
}

/**
 * The one guard decision the portal send path uses: refuse ONLY when the
 * client's language on file is Italian AND the draft is confidently English.
 * Every uncertain case (unknown client language, short/mixed draft) allows.
 * The clientLanguage argument is the RAW contacts.language value; callers pass
 * it through lib/locale.ts's isItalian — kept out of here so this module stays
 * dependency-free. See shouldRefusePortalDraft in worker-tools.ts.
 */
export function isConfidentlyEnglish(draft: string | null | undefined): boolean {
  return detectDraftLanguage(draft) === "en"
}
