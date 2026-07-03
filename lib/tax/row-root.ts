/**
 * rowRootKey — THE single merchant-root derivation (Phase 3R, cond. 12).
 *
 * One exported function used by ALL FOUR consumers in the same commit:
 * question-groups (review grouping), presence-periods (period merchants +
 * filter keys), learned-rules (pattern derivation), and the eval runner.
 * Before this module, four sites derived roots independently with two live
 * inconsistencies (case-sensitivity broke the period filter chip; learned
 * rules could derive from a different root than the group the human saw).
 *
 * Rules (adversarial-review conditions 11-14):
 * - DESCRIPTION-FIRST. Counterparty is a FALLBACK, used only when the
 *   stripped description root is degenerate — prod data falsified
 *   counterparty-first (the field holds MCC labels like "Restaurants" on
 *   thousands of rows: 402 rows / 137 DISTINCT merchants would have collapsed
 *   into one group).
 * - `source` tells the caller where the root came from; learned rules MUST
 *   NOT be derived from a counterparty-fallback root (cond. 13 — prevents
 *   "Unknown - Corporate Card" / "Restaurants" poison rules structurally).
 * - Wise transfer/receive sentences are stripped via WISE_TRANSFER_PHRASES —
 *   the closed format vocabulary of ONE parsed product (the parser already
 *   hardcodes the EN/IT variants twice; this module is the source of truth
 *   from now on, the parser migrates when ref-stability next allows).
 * - key is LOWERCASED for stable equality; label preserves display casing.
 */

export interface RowRoot {
  /** Stable grouping key (lowercased, trimmed, ≤40 chars). */
  key: string
  /** Display label (original casing of whatever produced the key). */
  label: string
  /** Where the root came from: 'description' | 'counterparty' | 'none'. */
  source: "description" | "counterparty" | "none"
}

/** Payment rails — never a learnable pattern (a contains-rule on "paypal"
 *  would blanket-book every PayPal-carried merchant). Shared with the
 *  learned-rules stoplist (cond. 13). */
export const RAIL_SET = new Set(["paypal", "stripe", "wise", "revolut", "klarna", "zelle", "venmo"])

/** Wise export sentence prefixes, per locale (send / receive families).
 *  CLOSED vocabulary of one product's export format — like Chase's ACCT_XFER
 *  token, not open-ended language logic. The root becomes the counterparty
 *  name that follows the phrase ("Se ha enviado dinero a LOREA LLP" → "LOREA
 *  LLP"). Conversion phrasings are NOT here — conversions are categorized,
 *  not grouped-by-merchant. */
export const WISE_TRANSFER_PHRASES: ReadonlyArray<RegExp> = [
  /^sent money to\s+/i,            // EN
  /^received money from\s+/i,
  /^inviato denaro a\s+/i,         // IT
  /^ricevuto denaro da\s+/i,
  /^se ha enviado dinero a\s+/i,   // ES
  /^has recibido dinero de\s+/i,
  /^se han enviado\s+/i,
  /^argent envoyé à\s+/i,          // FR
  /^argent reçu de\s+/i,
  /^geld gesendet an\s+/i,         // DE
  /^geld erhalten von\s+/i,
  /^dinheiro enviado para\s+/i,    // PT
  /^dinheiro recebido de\s+/i,
]

/** Leading transaction-type boilerplate that is not a merchant. */
const LEADING_BOILERPLATE: ReadonlyArray<RegExp> = [
  /^recurring card purchase(\s+with pin)?\s*/i,
  /^card purchase(\s+with pin)?\s*/i,
  /^purchase authorized on\s*/i,
  /^pos (purchase|debit)\s*/i,
]

/** After stripping, roots matching these are DEGENERATE — they identify a
 *  card/program, not a merchant → fall back to counterparty. */
const DEGENERATE_ROOT = /^(unknown([\s-]|$).*|corporate card.*|business (virtual )?card.*|card|spend|receive|debit|credit)?$/i

function stripDescription(raw: string): string {
  let s = raw
  // Chase/Relay FX-fee lines name the merchant they surcharge ("Foreign Exch
  // Rt ADJ Fee Sp Wildde London…") — they are all the SAME thing (a bank FX
  // fee), so they group as one, not one-per-merchant. Closed format vocabulary
  // of parsed products, same rationale as the Wise phrase table.
  if (/^foreign exch(ange)?\s+(rt|rate)\s+adj(ustment)?\s+fee\b/i.test(s)) return "Foreign exchange rate fee"
  // Wise sentence prefixes FIRST (the remainder is the counterparty name).
  for (const re of WISE_TRANSFER_PHRASES) {
    if (re.test(s)) { s = s.replace(re, ""); break }
  }
  // First pipe segment: Relay/Chase folds put the merchant before the first
  // '|' in every observed shape ("Eroski | Spend | Corporate Card - (…",
  // "SMRBINTERNATIONA | paypal", "… | DEBIT | ACCT_XFER").
  s = s.split("|")[0]
  for (const re of LEADING_BOILERPLATE) s = s.replace(re, "")
  return s
    .replace(/\s*••\d+/g, "")                 // card suffix dots
    .replace(/\b\d{1,2}[A-Z]{3}\b/g, "")      // Wise date tokens (12MAR)
    .replace(/\b\d{2}\/\d{2}\b/g, "")         // dd/dd dates
    .replace(/\bcard\s+\d{4}\b.*$/i, "")      // "Card 5790" tail + remnants
    .replace(/\bcorporate card\b.*$/i, "")    // "Corporate Card - 6921 (…)" tail
    .replace(/\b\d{4,}\b/g, "")               // long digit runs
    .replace(/[-–]\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
    .trim()
}

function isDegenerate(root: string): boolean {
  if (root.length < 3) return true
  if (/^\d+$/.test(root)) return true
  return DEGENERATE_ROOT.test(root)
}

export function rowRootKey(description: string | null | undefined, counterparty: string | null | undefined): RowRoot {
  const desc = (description ?? "").trim()
  const cp = (counterparty ?? "").trim()

  const descRoot = desc ? stripDescription(desc) : ""
  if (descRoot && !isDegenerate(descRoot)) {
    return { key: descRoot.toLowerCase(), label: descRoot, source: "description" }
  }
  if (cp) {
    const cpRoot = stripDescription(cp)
    if (cpRoot && !isDegenerate(cpRoot)) {
      return { key: cpRoot.toLowerCase(), label: cpRoot, source: "counterparty" }
    }
  }
  // Last resort: whatever the description root was (even degenerate) beats
  // nothing — rows still need SOME stable bucket.
  if (descRoot) return { key: descRoot.toLowerCase(), label: descRoot, source: "description" }
  return { key: "(no description)", label: "(no description)", source: "none" }
}
