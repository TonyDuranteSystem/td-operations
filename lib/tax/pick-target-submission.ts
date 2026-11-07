/**
 * Which tax submission does a workspace button act on?
 *
 * The SAME one the client's wizard gate lets them edit, so the button, the gate, the page prefill and the lock all act on ONE row:
 * when an OPEN tax record exists (data not received yet) the target is the OLDEST open year's latest submission (back-filing
 * collects oldest first); with no open record it is the latest submission overall. Blindly taking the newest row would act on a
 * different tax year than the client edits (cross-year contamination for a returning client with two submissions).
 *
 * Extracted from `syncTaxRevisionRequest` (bug-hunter #3, 2026-07-24) so "Request Changes" and "Approve" share it. Pure.
 */

export interface TargetableSubmission {
  tax_year: number | null
  created_at: string
}

function latestOf<T extends TargetableSubmission>(rows: T[]): T | null {
  return rows.length === 0 ? null : rows.reduce((a, b) => (a.created_at >= b.created_at ? a : b))
}

export function pickTargetSubmission<T extends TargetableSubmission>(subs: T[], openYears: number[]): T | null {
  const targetYear = openYears.length > 0 ? Math.min(...openYears) : null
  return targetYear !== null ? latestOf(subs.filter((s) => s.tax_year === targetYear)) : latestOf(subs)
}
