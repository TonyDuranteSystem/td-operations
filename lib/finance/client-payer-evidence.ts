/**
 * "Does this deposit name a client we know?" — the evidence the deposit router was missing.
 *
 * WHY THIS EXISTS (dev job `ae8b8bb1`, 2026-08-09). Domenico Cristiano wired €1,250 against
 * his €2,500 signed offer. The router (`isClientInvoicePayment`) looks for positive evidence
 * that a client is paying an invoice: an invoice number, a payer email, a card reference, a
 * human's prior triage, or an amount within max(20%, $50) of something owed. His wire carried
 * his NAME and nothing else, and €1,250 is 50% away from €2,500 — so every test failed and a
 * real client payment was filed as the owner's own money, invisible to the matching queue,
 * with no alert of any kind. It sat for two days.
 *
 * Two gaps, both closed here:
 *
 *  1. THE PAYER'S NAME WAS NEVER EVIDENCE AT ALL. The matcher scores names, the router never
 *     did. A deposit whose payer name covers a known client's name is not the owner's money
 *     under any reading.
 *
 *  2. A PART-PAYMENT IS INVISIBLE BY CONSTRUCTION. The 20% band cannot see a half-payment,
 *     and offer payment plans (WS-C) make half-payments the normal case. So an EXPECTED
 *     instalment amount is evidence in its own right: when a plan says "€1,250 is due", a
 *     €1,250 deposit is the thing that was expected.
 *
 * ⛔ THE REGRESSION THIS MODULE IS BUILT TO AVOID — verified against production, not reasoned.
 * The account named "Tony Durante LLC" IS the owner's own books entity (its id is the entity
 * sentinel; it was created the day the owner-ledger split shipped). TD's own name is printed
 * on TD's own bank descriptors — every Mercury Stripe payout reads
 * "STRIPE; TRANSFER; TONY DURANTE LLC; …" — so treating that row as a client name would score
 * 100% coverage on 43 payouts (about $57,300) and sweep every one of them back into Finance:
 * precisely the noise the split removed. The owner entity is therefore excluded BY ID, never
 * by name matching, because a name test cannot be trusted to exclude itself.
 *
 * Everything here is pure and takes its threshold by parameter, so tests pin behaviour rather
 * than the constant. The name rule itself is NOT re-implemented — it is the one shared
 * coverage test in `feed-signals.ts` (≥60% of the client's significant words, 4-char minimum,
 * shared stop-word list, diacritic-folded, word-boundary matched). A fourth private copy of
 * name matching is exactly what the 2026-07-29 wrong-client incident was made of.
 */

import {
  NAME_COVERAGE_THRESHOLD,
  evaluateNameEvidence,
  type NameEvidence,
} from "@/lib/finance/feed-signals"
import { TD_ENTITY_ID } from "@/lib/owner-finance"

/** One name a deposit could plausibly belong to: a client company, or a person. */
export interface ClientRosterEntry {
  id: string
  name: string | null | undefined
  kind: "account" | "contact"
}

export interface PayerMatch {
  entry: ClientRosterEntry
  evidence: NameEvidence
}

export interface PayerMatchResult {
  /**
   * Coverage met the bar — this deposit NAMES this client. Strong enough to route on:
   * money from a name that identifies a client is not the owner's own money.
   */
  named: PayerMatch | null
  /**
   * Something matched, but not enough of the name. Deliberately NEVER routed on — a surname
   * or one generic word identifies nobody. It is good enough to TELL A HUMAN, which is the
   * established split in this codebase: strict rules for automatic decisions, hints for
   * people (see the audit panel's "partial name: …" label).
   */
  weak: PayerMatch | null
}

const EMPTY_RESULT: PayerMatchResult = { named: null, weak: null }

/**
 * The owner's own entity can never be the client paying. Excluded by ID on purpose — see the
 * regression note in this file's header.
 */
export function isOwnEntityRosterEntry(entry: ClientRosterEntry): boolean {
  return entry.id === TD_ENTITY_ID
}

/**
 * Best client-name evidence for one deposit across the whole roster.
 *
 * Returns the strongest sufficient match and, separately, the strongest weak one. Ties keep
 * the first seen, so the caller's ordering decides — the roster is loaded in a stable order
 * for that reason.
 */
export function matchPayerToRoster(
  feedTexts: Array<string | null | undefined>,
  roster: ClientRosterEntry[],
  threshold: number = NAME_COVERAGE_THRESHOLD,
): PayerMatchResult {
  if (!roster.length) return EMPTY_RESULT

  let named: PayerMatch | null = null
  let weak: PayerMatch | null = null

  for (const entry of roster) {
    if (isOwnEntityRosterEntry(entry)) continue

    const evidence = evaluateNameEvidence(entry.name, feedTexts, threshold)
    if (evidence.words.length === 0) continue

    if (evidence.sufficient) {
      if (!named || evidence.coverage > named.evidence.coverage) named = { entry, evidence }
    } else if (evidence.weak && evidence.matchedWords.length >= MIN_WEAK_MATCHED_WORDS) {
      if (!weak || evidence.coverage > weak.evidence.coverage) weak = { entry, evidence }
    }
  }

  return { named, weak }
}

/**
 * How many of a client's words must appear before a PARTIAL match is worth telling someone.
 *
 * ⛔ MEASURED, NOT CHOSEN. Replaying the rule over the real book with a one-word threshold
 * raised a notice on 27 of 64 rows — every Stripe payout matched the surname of a contact who
 * shares TD's own family name, and every Relay "Partner Payout Program" row matched the first
 * word of a client called "Partner Alliance". All 27 were correctly filed. A channel that cries
 * wolf on correct rows is worse than no channel: it teaches people to skip the one that matters,
 * which is the exact failure this signal exists to prevent. Two words costs nothing real — a
 * truncated company name ("Oh My Crea" for "Oh My Creatives") matches zero words either way.
 */
export const MIN_WEAK_MATCHED_WORDS = 2

/** An amount the system is already expecting from a client — an instalment on a payment plan. */
export interface ExpectedPayment {
  amount: number
  currency?: string | null
  /** Human label for the notice / audit trail, e.g. "instalment 1 of 2 on offer …". */
  label?: string
}

/**
 * How far a wire may land from the expected figure and still count as that instalment.
 *
 * A quoted instalment is a number the client was told to send, so this is TIGHT compared with
 * the router's 20% "could be an invoice" band — but not exact: intermediary banks shave fees
 * off a cross-border wire, and a client rounding €1,250 to €1,248 has still paid instalment 1.
 * 2% (floor 1 unit) covers wire fees without reaching the next instalment of any realistic
 * plan. Over-caution here costs a row the owner moves back with one click; under-caution costs
 * a client's payment — the same asymmetry the router was built around.
 */
export const EXPECTED_PAYMENT_TOLERANCE_PCT = 0.02

/**
 * Does this deposit match something a client was expected to pay? Same-currency only: a €1,250
 * deposit is not evidence for a $1,250 instalment, and credit/FX never converts silently here.
 */
export function matchesExpectedPayment(
  amount: number,
  currency: string | null | undefined,
  expected: ExpectedPayment[],
  tolerancePct: number = EXPECTED_PAYMENT_TOLERANCE_PCT,
): ExpectedPayment | null {
  if (!Number.isFinite(amount) || amount <= 0) return null
  const feedCurrency = (currency || "USD").toUpperCase()

  for (const exp of expected) {
    if ((exp.currency || "USD").toUpperCase() !== feedCurrency) continue
    const target = Math.abs(Number(exp.amount))
    if (!Number.isFinite(target) || target <= 0) continue
    if (Math.abs(Math.abs(amount) - target) <= Math.max(target * tolerancePct, 1)) return exp
  }

  return null
}

/**
 * Could this deposit be a PART-payment of something a client still owes?
 *
 * Deliberately NOT routing-strength on its own, and this is the whole point: almost any
 * deposit is a plausible fraction of some open invoice, so routing on it alone would drag
 * every Stripe payout back into Finance. It is a HINT — paired with a weak name match it
 * tells a human where to look, and nothing more.
 */
export function couldBePartPayment(
  amount: number,
  currency: string | null | undefined,
  owed: Array<{ amount: number; currency?: string | null }>,
): boolean {
  if (!Number.isFinite(amount) || amount <= 0) return false
  const feedCurrency = (currency || "USD").toUpperCase()

  return owed.some((inv) => {
    if ((inv.currency || "USD").toUpperCase() !== feedCurrency) return false
    const total = Math.abs(Number(inv.amount))
    if (!Number.isFinite(total) || total <= 0) return false
    // Strictly less than the whole bill (an equal amount is already covered by the router's
    // own band) and not a rounding-error sliver of it.
    return Math.abs(amount) < total && Math.abs(amount) >= total * 0.1
  })
}
