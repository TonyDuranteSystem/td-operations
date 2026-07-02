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

export interface TransferCandidate {
  /** Unique row identity (bank_transactions.id or transaction_ref). */
  id: string
  transaction_date: string // YYYY-MM-DD
  amount: number // signed: positive inflow, negative outflow
  currency: string
  bank_name: string
  /** Sub-account discriminator (account_type / account label). */
  account_type: string
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
      // must cross accounts: different bank, or same bank different sub-account
      if (inn.bank_name === out.bank_name && inn.account_type === out.account_type) continue
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
