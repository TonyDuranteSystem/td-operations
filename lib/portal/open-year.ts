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
