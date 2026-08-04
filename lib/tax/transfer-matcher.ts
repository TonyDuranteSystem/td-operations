/**
 * Transfer-pair matcher — internal moves between a client's own bank accounts
 * must never count as revenue or expense (master plan §4: excluded from P&L).
 *
 * A transfer shows up twice in the client's data: an OUTFLOW at bank A and an
 * equal INFLOW at bank B, usually within a few days (ACH/wire settlement).
 * Counting the inflow as income overstates revenue; counting the outflow as
 * an expense overstates costs. Real case: Dynamiq SR moves money between
 * Wise, Mercury, Relay and Chase constantly — unmatched, those moves inflated
 * both sides of the 2025 P&L.
 *
 * Pure function — no DB access. The caller loads the account-year transaction
 * set and persists the category changes.
 */

import { accountKeyOf } from "./bank-identity"

export interface TransferCandidate {
  /** Unique row identity (bank_transactions.id or transaction_ref). */
  id: string
  transaction_date: string // YYYY-MM-DD
  amount: number // signed: positive inflow, negative outflow
  currency: string
  bank_name: string
  /** Sub-account discriminator (account_type / account label). */
  account_type: string
  /** Client-confirmed account identity key. When present it is the authoritative
   *  "which account" — so two accounts at the SAME bank are correctly seen as
   *  different, and one account under two bank-name spellings is seen as the same. */
  account_ref?: string | null
  category: string
}

export interface TransferPair {
  outflowId: string
  inflowId: string
  amount: number
  daysApart: number
}

export interface TransferMatchOptions {
  /** Max calendar days between the two legs (default 5). */
  windowDays?: number
  /** Categories eligible for matching (default: the ones a transfer could
   *  have been mis-filed under). Already-identified fees/conversions are
   *  left alone. */
  matchableCategories?: string[]
}

const DEFAULT_MATCHABLE = ["uncategorized", "income", "expense", "contribution"]

function daysBetween(a: string, b: string): number {
  return Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000)
}

// ── Own-entity self-transfer detection ────────────────────────────────────
// Pure amount-pair matching (above) MISSES a self-transfer when its mirror leg
// isn't in the data, or a fee/FX changed the amount (real case: Dynamiq's 84
// "sent money to Dynamiq SR LLC" Wise moves — 0 had an equal-amount inflow
// within 5 days, so all 84 fell through to the AI and were mis-booked as
// expense). The strongest signal a CPA uses: the counterparty IS the company's
// own name / own account — money to/from yourself is an internal transfer
// regardless of whether a matching leg exists. dev_task 3639451c.

const ENTITY_SUFFIX = /\b(llc|l\.l\.c|inc|incorporated|corp|corporation|ltd|limited|co|company|srl|s\.r\.l|sr)\b/g

/** Normalize an entity/counterparty string for self-reference comparison:
 *  lowercase, drop punctuation, strip common entity suffixes, collapse spaces.
 *  "Dynamiq SR LLC" and "sent money to DYNAMIQ S.R. LLC" both reduce so one
 *  contains the other. Exported for tests. */
export function normalizeEntityName(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/\./g, "")        // collapse dotted abbreviations FIRST: s.r.l→srl, l.l.c→llc
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(ENTITY_SUFFIX, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Collapse runs of single-letter tokens into one word: "b p international" →
 *  "bp international". Banks routinely drop the "&"/dots that produced the
 *  split ("B&P International" appears as "BP International" in wire text), so
 *  self-reference matching must recognize both spellings. Exported for tests. */
export function nameVariants(normalized: string): string[] {
  const toks = normalized.split(" ").filter(Boolean)
  const merged: string[] = []
  let run = ""
  for (const t of toks) {
    if (t.length === 1) { run += t; continue }
    if (run) { merged.push(run); run = "" }
    merged.push(t)
  }
  if (run) merged.push(run)
  const collapsed = merged.join(" ")
  return collapsed !== normalized ? [normalized, collapsed] : [normalized]
}

export interface OwnEntityRow {
  id: string
  description?: string | null
  counterparty?: string | null
  category: string
  /** Signed amount. Negative = money OUT, which gets the strict recipient test
   *  below. Absent/undefined keeps the pre-2026-08-03 contains-match (callers
   *  that don't know the direction lose nothing). */
  amount?: number | null
}

/**
 * On an OUTGOING payment, is the company named as the RECIPIENT?
 *
 * Why this exists (2026-08-03, Titan Real Estate): the old rule asked only
 * "does this row mention our own name?" — but an outgoing wire ALWAYS mentions
 * it, as the sender. Titan's payments to F.INVEST Dubai and Bulgaria carried
 * "From TITAN REAL ESTATE GROUP LLC" and were swallowed as internal transfers:
 * excluded from the P&L and never queued for the client, hiding 49,000 of real
 * cost. VSV210's payment to Tony Durante LLC went the same way.
 *
 * Two shapes are genuine and must keep working (verified against every
 * own-entity row in production):
 *   1. the payee field IS the company  — "Sent money to DYNAMIQ SR LLC"
 *   2. payee empty, but the text names the company after a DESTINATION marker
 *      — "ONLINE DOMESTIC WIRE TRANSFER ... A/C: BP INTERNATIONAL"
 * A name sitting after a SOURCE marker ("from") is the sender, not the payee.
 *
 * Deliberately conservative: anything that matches neither is NOT auto-hidden.
 * It falls through to the normal flow and reaches the client's question queue,
 * which is the whole point — when we can't tell, we ask instead of guessing.
 */
function namedAsRecipient(row: OwnEntityRow, names: string[]): boolean {
  // 1. Payee field names the company → unambiguous self-transfer.
  const cp = normalizeEntityName(row.counterparty ?? "")
  if (cp && names.some(n => cp.includes(n))) return true

  // 2. Fall back to the free text, but only where the name follows a marker
  //    that means "sent TO". Markers are matched in the SAME normalized space
  //    as the name, so "A/C:" arrives here as "a c".
  const hay = normalizeEntityName(row.description ?? "")
  if (!hay) return false
  const DESTINATION = [" to ", " a c ", " beneficiary ", " a favore di ", " payee "]
  const SOURCE = [" from ", " da "]

  // Mercury's export shape is "<payee> | From <sender> | <memo>" — the payee
  // leads, with no "to" in front of it. So a name sitting BEFORE the first
  // source marker is the payee. This is what separates two otherwise identical
  // rows found in production: "Dynamiq Relay (Dynamiq Sr LLC) | From Dynamiq SR
  // LLC" is Mercury→Relay, the client's own money (KEEP hidden), while
  // "F. INVEST DUBAI (...) | From TITAN REAL ESTATE GROUP LLC" pays a separate
  // company (RELEASE). Found by replaying this rule over all 581 real
  // own-entity rows — without it, Dynamiq's genuine transfer was a false alarm.
  const firstSource = Math.min(
    ...SOURCE.map(m => { const i = ` ${hay} `.indexOf(m); return i === -1 ? Number.MAX_SAFE_INTEGER : i }),
  )
  if (firstSource !== Number.MAX_SAFE_INTEGER) {
    const leading = ` ${hay} `.slice(0, firstSource)
    if (names.some(n => leading.includes(n))) return true
  }

  for (const n of names) {
    let at = hay.indexOf(n)
    while (at !== -1) {
      const before = ` ${hay.slice(0, at)} `
      const lastDest = Math.max(...DESTINATION.map(m => before.lastIndexOf(m)))
      const lastSrc = Math.max(...SOURCE.map(m => before.lastIndexOf(m)))
      // The NEAREST preceding marker wins — a line can carry both a sender and
      // a recipient ("... from <own> ... to <vendor>" and the reverse).
      if (lastDest > lastSrc) return true
      at = hay.indexOf(n, at + 1)
    }
  }
  return false
}

export interface OwnEntityOptions {
  /** The company's own legal name(s) / own-account labels. */
  ownNames: string[]
  /** Categories a mis-booked self-transfer could be sitting in (contains-match
   *  path). Deliberately EXCLUDES distribution/contribution (owner equity —
   *  member-name precedence) and cogs/conversion. `income` is NOT part of this
   *  set either — income rows are handled by a separate, STRICTER path inside
   *  the detector (exact counterparty == own name), so a real sale can never
   *  be swallowed by a contains-match. */
  matchableCategories?: string[]
}

const OWN_ENTITY_MATCHABLE = ["uncategorized", "expense", "fee"]

/**
 * Rows whose description/counterparty names the company's OWN entity (money
 * to/from yourself) → internal transfers, even with no matching leg.
 *
 * Conservative by construction:
 * - only a DISTINCTIVE normalized own-name (≥5 chars after suffix-strip) fires,
 *   so a short/generic name ("ABC Co" → "abc") can never blanket-match vendors;
 * - the FULL normalized own-name must appear as a contiguous substring;
 * - only matchable categories are touched (never distribution/income/manual).
 * Returns the ids to reclassify as 'conversion'.
 */
export function detectOwnEntityTransfers(rows: OwnEntityRow[], opts: OwnEntityOptions): string[] {
  const matchable = new Set(opts.matchableCategories ?? OWN_ENTITY_MATCHABLE)
  const names = Array.from(new Set(opts.ownNames.map(normalizeEntityName).flatMap(nameVariants))).filter(n => n.length >= 5)
  if (names.length === 0) return []
  const hits: string[] = []
  for (const r of rows) {
    // INCOME self-payments (2026-07-02, B&P €29,269 incident): the Wise
    // built-in books "Received money from <own company> — BUSINESS EXPENSES"
    // as income BEFORE this pass runs, and income was untouchable — so the
    // company's own Chase→Wise moves stayed inside revenue. Income rows get a
    // STRICTER path than the contains-match below: reclassify only when the
    // normalized COUNTERPARTY *equals* an own-name (money whose payer IS the
    // company itself is never revenue). A real customer with a merely similar
    // name ("B&P International Consulting GmbH") can never be swallowed.
    if (r.category === "income") {
      const cp = normalizeEntityName(r.counterparty ?? "")
      if (cp && nameVariants(cp).some(v => names.includes(v))) hits.push(r.id)
      continue
    }
    if (!matchable.has(r.category)) continue

    // OUTGOING money gets the strict recipient test (2026-08-03). An outgoing
    // wire always names the company — as the SENDER — so a plain contains-match
    // swallowed real payments to third parties. See namedAsRecipient.
    if (typeof r.amount === "number" && r.amount < 0) {
      if (namedAsRecipient(r, names)) hits.push(r.id)
      continue
    }

    // Incoming / unknown direction: unchanged. Here the own name legitimately
    // appears as the SOURCE ("Received money from <own company>"), so the
    // contains-match is the correct signal and tightening it would break it.
    const hay = normalizeEntityName(`${r.description ?? ""} ${r.counterparty ?? ""}`)
    if (!hay) continue
    if (names.some(n => hay.includes(n))) hits.push(r.id)
  }
  return hits
}

/**
 * Find internal transfer pairs across the client's accounts.
 *
 * Pairing rules (all must hold):
 * - same currency, equal absolute amount (to the cent)
 * - opposite signs
 * - DIFFERENT bank or different sub-account at the same bank (a refund from a
 *   vendor at the same account is NOT a transfer)
 * - dates within the window
 * - each row pairs at most once; nearest-in-time wins (greedy, deterministic:
 *   candidates sorted by date then id)
 */
export function matchTransferPairs(
  txs: TransferCandidate[],
  opts?: TransferMatchOptions,
): TransferPair[] {
  const windowDays = opts?.windowDays ?? 5
  const matchable = new Set(opts?.matchableCategories ?? DEFAULT_MATCHABLE)

  const eligible = txs.filter(t => matchable.has(t.category) && Number.isFinite(t.amount) && t.amount !== 0)
  const sortKey = (t: TransferCandidate) => `${t.transaction_date}|${t.id}`
  const outflows = eligible.filter(t => t.amount < 0).sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
  const inflows = eligible.filter(t => t.amount > 0).sort((a, b) => sortKey(a).localeCompare(sortKey(b)))

  const usedInflows = new Set<string>()
  const pairs: TransferPair[] = []

  for (const out of outflows) {
    let best: { inflow: TransferCandidate; days: number } | null = null
    for (const inn of inflows) {
      if (usedInflows.has(inn.id)) continue
      if (inn.currency !== out.currency) continue
      if (Math.abs(Math.abs(inn.amount) - Math.abs(out.amount)) > 0.005) continue
      // must cross accounts. account_ref (when present) is the authoritative account
      // identity — same ref + same currency = same account, not a transfer; two
      // accounts at one bank have distinct refs and DO qualify.
      if (accountKeyOf(inn) === accountKeyOf(out)) continue
      const days = daysBetween(inn.transaction_date, out.transaction_date)
      if (days > windowDays) continue
      if (!best || days < best.days) best = { inflow: inn, days }
    }
    if (best) {
      usedInflows.add(best.inflow.id)
      pairs.push({
        outflowId: out.id,
        inflowId: best.inflow.id,
        amount: Math.abs(out.amount),
        daysApart: Math.round(best.days * 100) / 100,
      })
    }
  }
  return pairs
}
