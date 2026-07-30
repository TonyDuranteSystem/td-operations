/**
 * Feed signals — the shared primitives for "who sent this money, and what for?".
 *
 * Extracted 2026-07-14 (Simple Holdings / Fazekas incident).
 *
 * SCOPE — read this before trusting the module name. The NEW identity signals
 * (payment-intent link, payer email, invoice reference) live here and ONLY here, so
 * they cannot drift. The OLD name-fuzzing logic is NOT yet consolidated: the matcher
 * (`lib/bank-feed-matcher.ts`), the audit cascade (`lib/audit/bank-feed-cascade.ts`)
 * and the Finance UI's client-side scorer still each carry their own stop-word list
 * and their own feed-text builder. Folding those three into this module is deliberately
 * deferred work — do not assume it has happened.
 */

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g

/** A bank-feed row, as far as identity resolution is concerned. */
export interface FeedSignalSource {
  source?: string | null
  sender_name?: string | null
  memo?: string | null
  sender_reference?: string | null
  raw_data?: unknown
}

/**
 * Every email address we can find on a feed — from the memo text and from the
 * Stripe charge payload (billing_details.email / receipt_email / metadata.email).
 *
 * This is the STRONGEST identity signal available on a card payment: the cardholder
 * name is unreliable, but the billing email reliably resolves to a CRM contact and,
 * through account_contacts, to the company being paid for.
 */
export function extractFeedEmails(feed: FeedSignalSource): string[] {
  const out = new Set<string>()
  const text = `${feed.sender_name ?? ""} ${feed.memo ?? ""} ${feed.sender_reference ?? ""}`
  for (const m of text.match(EMAIL_RE) ?? []) out.add(m.toLowerCase())

  if (feed.raw_data && typeof feed.raw_data === "object") {
    const rd = feed.raw_data as {
      metadata?: { email?: unknown; client_email?: unknown }
      billing_details?: { email?: unknown }
      receipt_email?: unknown
    }
    const candidates = [
      rd.metadata?.email,
      rd.metadata?.client_email,
      rd.billing_details?.email,
      rd.receipt_email,
    ]
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) out.add(c.trim().toLowerCase())
    }
  }
  return Array.from(out)
}

/**
 * The Stripe PaymentIntent id on a stored charge (`raw_data.payment_intent`).
 *
 * This is the CERTAIN link: when our Stripe webhook marks an invoice paid it stores
 * that same PaymentIntent id on the invoice. Comparing the two ties a bank-feed row
 * to its invoice with no guessing at all — and it works retroactively on charges
 * already in the table. Nothing compared them before 2026-07-14, which is why every
 * Stripe-paid invoice left a permanently unmatched feed row behind.
 */
export function extractStripePaymentIntent(feed: FeedSignalSource): string | null {
  if (feed.source !== "stripe") return null
  if (!feed.raw_data || typeof feed.raw_data !== "object") return null
  const pi = (feed.raw_data as { payment_intent?: unknown }).payment_intent
  if (typeof pi === "string" && pi.startsWith("pi_")) return pi
  // Expanded PaymentIntent object (when the sync expands it).
  if (pi && typeof pi === "object") {
    const id = (pi as { id?: unknown }).id
    if (typeof id === "string" && id.startsWith("pi_")) return id
  }
  return null
}

/**
 * The invoice number Stripe carried on the payment, if any.
 *
 * Read from the charge metadata AND from the expanded PaymentIntent's metadata —
 * Stripe does NOT copy Checkout Session metadata onto the Charge (that assumption is
 * precisely what broke reconciliation: we set the invoice number on the session, and
 * it never reached the feed). Reading the PaymentIntent removes the bet entirely.
 */
export function extractInvoiceReference(feed: FeedSignalSource): string | null {
  if (!feed.raw_data || typeof feed.raw_data !== "object") return null
  const rd = feed.raw_data as {
    metadata?: { invoice_number?: unknown }
    payment_intent?: { metadata?: { invoice_number?: unknown } } | string
  }

  const fromCharge = rd.metadata?.invoice_number
  if (typeof fromCharge === "string" && fromCharge.trim()) return fromCharge.trim()

  if (rd.payment_intent && typeof rd.payment_intent === "object") {
    const fromPi = rd.payment_intent.metadata?.invoice_number
    if (typeof fromPi === "string" && fromPi.trim()) return fromPi.trim()
  }
  return null
}

// ════════════════════════════════════════════════════════════════════════════════════════
// NAME EVIDENCE — "does this payment actually name this client?"
//
// ⛔ THE INCIDENT THIS EXISTS TO PREVENT (2026-07-22, production, $1,000).
// A Mercury wire from "LC Marketing Consulting" was auto-credited to a DIFFERENT client,
// Aces Marketing Solutions LLC. Both held an open $1,000 invoice, the wire carried no
// invoice number and no email, and the old rule counted a name as matched if ANY ONE of its
// significant words appeared in the payment text. For both companies that word was
// "marketing" — a word they share and which identifies neither. Both scored top confidence,
// the tie was broken by whichever database row came back first, and the wrong client's
// invoice was settled with no human ever seeing it.
//
// THE RULE NOW — TWO LAYERS, both required:
//   1. A generic industry word is not evidence of anybody ("marketing" is now on the list).
//   2. The words that DO match must COVER a minimum share of the client's own name.
//
//   "Aces Marketing Solutions LLC" → significant words {aces}; "aces" is absent from the wire
//   → coverage 0 → no evidence. The wrong client is no longer settled.
//   "LC Marketing Consulting LLC"  → significant words {} — "lc" is too short, "consulting"
//   and "llc" are generic, "marketing" is generic → this company's NAME cannot identify it at
//   all, so its invoice is not auto-settled either. The wire parks for a human.
//
// ⚠️ THAT SECOND OUTCOME IS DELIBERATE, AND IT CORRECTS THE FIRST DRAFT OF THIS FIX.
// The plan said coverage alone would let the CORRECT client (LC) auto-settle on the word
// "marketing" while blocking Aces. That is unsafe: if "marketing" can settle LC's invoice,
// then a wire from any OTHER company with "marketing" in its name — a stranger — settles LC's
// invoice too, which is the identical bug pointed at a different victim. A client whose name
// consists only of generic words genuinely cannot be identified by name; their payments need
// the invoice number (which the portal Pay modal and the invoice PDF both demand) or a human.
// Losing an automatic match costs a click. Crediting the wrong client costs trust.
//
// WHY COVERAGE ON TOP OF THE STOP-WORD LIST: the list is hand-maintained and was missing
// "marketing"; it will always be missing the next one. Coverage means a single forgotten
// generic word can no longer, by itself, decide who gets paid.
// WHY NOT "is this word unique among our clients": that was the first design and it was
// rejected in review — it makes matching a function of the live client roster (a renamed or
// duplicated account silently re-arms this incident, with no test failing), it has no
// well-defined per-client identity key, and an ASCII-ised bank name ("CAFE MOVIL" for
// "Café Móvil") could acquire ANOTHER client's unique word and settle with MORE confidence
// than today. Coverage is pure, deterministic and replayable.
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * Words excluded from name evidence: legal suffixes, generic industry words that
 * cross-match unrelated companies, filler, and payment-processor names that appear in the
 * sender field but are not the client.
 *
 * This list is a cheap pre-filter, NOT the defence — see the header. Adding a word here is
 * always safe; forgetting one is no longer catastrophic, because coverage still has to be met.
 */
export const NAME_STOP_WORDS: ReadonlySet<string> = new Set([
  // Legal suffixes
  "llc", "inc", "ltd", "corp", "co", "plc", "gmbh", "srl",
  // Generic business words (cause cross-company false matches)
  "consulting", "consultancy", "commerce", "international", "services", "holdings",
  "management", "solutions", "ventures", "capital", "partners",
  "trading", "digital", "global", "group", "media", "investments",
  "properties", "enterprises", "advisors", "associates", "agency",
  "solution", "strategies", "accelerator", "marketing",
  // Common filler words
  "the", "and", "for", "via", "from", "tax", "return", "annual",
  "service", "fee", "payment", "invoice", "contractor", "vendor",
  "company", "first",
  // Payment processor names (appear in sender but aren't the actual client)
  "wise",
])

/**
 * The share of a name's own significant words that must appear in the payment text before
 * the name counts as evidence of WHO PAID.
 *
 * 0.6 is chosen so a two-word name needs BOTH words (0.5 < 0.6) — that is the incident case —
 * while a three-word name may match two of three. Single-significant-word clients
 * ("Marka LLC", "GScaling International LLC") are unaffected: one word matched is 100%.
 */
export const NAME_COVERAGE_THRESHOLD = 0.6

/** Minimum length of a word that may carry name evidence. Two-letter tokens ("LC", "US")
 *  match far too eagerly on a word boundary to identify anybody. */
const MIN_NAME_WORD_LENGTH = 4

/** Lowercase + strip diacritics, so a bank that prints "CAFE MOVIL" for "Café Móvil" is
 *  still comparable. Both sides go through this, so folding can never invent a match that
 *  coverage does not then have to justify. */
export function normalizeNameText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
}

/** The words of a company/person name that may carry identity evidence. */
export function nameSignificantWords(name: string): string[] {
  return Array.from(
    new Set(
      normalizeNameText(name)
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= MIN_NAME_WORD_LENGTH && !NAME_STOP_WORDS.has(w)),
    ),
  )
}

export interface NameEvidence {
  /** The name's significant words. Empty ⇒ this name can never be evidence. */
  words: string[]
  /** Which of them appear in the payment text. */
  matchedWords: string[]
  /** matchedWords / words, 0 when there are no significant words. */
  coverage: number
  /** Coverage met the threshold — this payment names this client. */
  sufficient: boolean
  /** Something matched, but not enough of the name. Real but weak: keeps the invoice as a
   *  candidate at a tier that never auto-settles. */
  weak: boolean
}

const EMPTY_EVIDENCE: NameEvidence = {
  words: [],
  matchedWords: [],
  coverage: 0,
  sufficient: false,
  weak: false,
}

/**
 * Evaluate one name against the payment's text fragments (sender, memo, reference…).
 * Pure. `threshold` is injectable so tests pin behaviour rather than the constant.
 */
export function evaluateNameEvidence(
  name: string | null | undefined,
  feedTexts: Array<string | null | undefined>,
  threshold: number = NAME_COVERAGE_THRESHOLD,
): NameEvidence {
  const words = nameSignificantWords(name ?? "")
  if (words.length === 0) return EMPTY_EVIDENCE

  const haystacks = feedTexts
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .map(normalizeNameText)
  if (haystacks.length === 0) return { ...EMPTY_EVIDENCE, words }

  const matchedWords = words.filter((w) => {
    // Word-boundary test, not substring: "solution" must not match inside "solutions".
    const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)
    return haystacks.some((h) => re.test(h))
  })

  const coverage = matchedWords.length / words.length
  return {
    words,
    matchedWords,
    coverage,
    sufficient: coverage >= threshold,
    weak: matchedWords.length > 0 && coverage < threshold,
  }
}

/**
 * Best evidence across a pool of names for one invoice — the invoice's own account plus every
 * company the linked contact is a member of (third-party payments), plus the contact's own
 * name. Returns the strongest result; ties on coverage keep the first.
 */
export function bestNameEvidence(
  names: Array<string | null | undefined>,
  feedTexts: Array<string | null | undefined>,
  threshold: number = NAME_COVERAGE_THRESHOLD,
): NameEvidence {
  let best = EMPTY_EVIDENCE
  for (const name of names) {
    const ev = evaluateNameEvidence(name, feedTexts, threshold)
    if (ev.coverage > best.coverage || (ev.words.length > 0 && best.words.length === 0)) {
      best = ev
    }
  }
  return best
}

/*
 * REMOVED 2026-07-27 — `classifyFeedType` and its Stripe wording signature.
 *
 * It labelled a row's type by reading the bank's description text. Antonio rejected that:
 * wording differs per bank and breaks the day payouts move accounts. The decision now lives
 * in `lib/finance/owner-ledger-projection.ts::isClientInvoicePayment`, which proves the
 * POSITIVE — a deposit stays in Finance only when something concrete says a client is paying
 * an invoice — and sends everything else to My Finances, visible and reversible.
 */
