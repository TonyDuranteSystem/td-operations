/**
 * Foreign-currency → USD conversion for the tax financials (Phase 2, 2026-06-19).
 *
 * Clients are paid in EUR/other on Wise; most of that is converted/transferred
 * internally (category 'conversion', excluded from the P&L), but some clients
 * genuinely SPEND in a foreign currency — a real expense that must land on the
 * P&L in USD. The IRS requires the YEARLY AVERAGE rate (one rate per currency
 * per tax year), stored in `irs_exchange_rates.rate_to_usd` as FOREIGN UNITS PER
 * USD (e.g. EUR 2025 = 0.886 → 1 USD = 0.886 EUR). So USD = amount / rate. This
 * matches the Excel P&L path (lib/pnl-generator.ts `toUSD`).
 *
 * Pure — no DB. The caller loads the rate map and passes it in.
 */

/** currency code → rate_to_usd (foreign units per 1 USD). USD itself is omitted/1. */
export type FxRates = Record<string, number>

export interface FxResult {
  /** Amount expressed in USD. */
  usd: number
  /** True when a non-USD amount had NO rate available — left unconverted; the
   *  caller should surface this rather than silently treat it as 1:1. */
  missingRate: boolean
}

/**
 * Convert a signed amount in `currency` to USD using the IRS yearly-average rate.
 * - USD (or empty/null currency) → unchanged.
 * - Non-USD with a positive rate → amount / rate (IRS direction).
 * - Non-USD with NO rate (or a non-positive rate) → unchanged + missingRate=true.
 */
export function toUsd(amount: number, currency: string | null | undefined, rates: FxRates): FxResult {
  const cur = (currency ?? "").trim().toUpperCase()
  if (!cur || cur === "USD") return { usd: amount, missingRate: false }
  const rate = rates[cur]
  if (!(typeof rate === "number" && rate > 0)) return { usd: amount, missingRate: true }
  return { usd: amount / rate, missingRate: false }
}
