/**
 * Portal tax-financials year selection (2026-07-07 — Dynamiq 2024 rebuild).
 * An amendment/correction can leave an older tax year open (data_received =
 * false) next to the current cycle; the portal page lists every open year and
 * picks the requested one when genuinely open, else the newest. PURE.
 */
export function pickOpenYear(openYears: number[], requested: string | undefined): number | null {
  if (openYears.length === 0) return null
  const req = Number(requested)
  if (Number.isInteger(req) && openYears.includes(req)) return req
  return Math.max(...openYears)
}

/**
 * Union of years still awaiting initial submission (data_received=false) and
 * years whose intake already closed but still carry a generated P&L with real
 * uncategorized transactions (2026-08-24, Adact Studio International — the
 * client's own tax-year confirmation flipped data_received=true back in
 * April, months before their bank statements were imported and a P&L built;
 * the review page had no way to show them a year already marked "received").
 * A year in EITHER set is reachable; pickOpenYear then chooses among them
 * exactly as before. PURE.
 */
export function mergeReachableYears(openYears: number[], pendingReviewYears: number[]): number[] {
  return Array.from(new Set([...openYears, ...pendingReviewYears])).sort((a, b) => b - a)
}
