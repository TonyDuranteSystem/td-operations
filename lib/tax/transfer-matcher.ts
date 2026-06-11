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
