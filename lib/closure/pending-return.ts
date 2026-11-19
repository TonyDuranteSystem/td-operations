/**
 * A pending FINAL tax return holds a company's closing (dev job 0a60f416, part C — Antonio's rule, first decided 2026-10-15 as "choice B" in the Wrap-up design,
 * lib/closure/wrapup-facts.ts: an open Tax Return keeps the company Active until it reaches "TR Filed").
 *
 * Carasso: Company Closure + a Tax Return sold for 2026 and filed in 2027. When the closure job reaches "Closing" the system used to cancel every other open
 * service (the Tax Return too), cancel the unpaid invoices and turn the portal off. Now, when a Tax Return is still open:
 *   - the Tax Return, its to-dos, its tax deadlines and the unpaid invoices of ITS offer are left alone;
 *   - the company is NOT set to Closed and the portal stays on (the portal shows a company while it is Active or Suspended);
 *   - the rest of the closing is done, a marker note is left on the closure job, and the closure's own follow-up to-dos are created as always;
 *   - when the last such Tax Return is filed (or cancelled by hand) the same closing completes — idempotent, the company becomes Closed then.
 *
 * Pure: no database, no I/O. The reads and writes are in lib/operations/close-company.ts and lib/closure/closing-wait.ts.
 */
import { TAX_RETURN_SERVICES } from '@/lib/closure/wrapup-facts'

/** The note left on the closure job while the company waits for its final tax return. Everything that asks "is this company waiting?" keys on it. */
export const CLOSING_WAITS_MARKER = 'CLOSING WAITS FOR THE FINAL TAX RETURN'

/** Statuses of a job that is still open (the same list the closing step uses). */
export const OPEN_JOB_STATUSES = ['active', 'on_hold', 'blocked'] as const

export interface OpenJob {
  id: string
  service_type: string
  status?: string | null
  service_name?: string | null
  source_offer_token?: string | null
}

/** The open jobs that HOLD the closing: an open Tax Return (either Tax Return job type). */
export function holdingReturns<T extends OpenJob>(open: readonly T[]): T[] {
  return open.filter((j) => TAX_RETURN_SERVICES.includes(j.service_type))
}

/** The offers whose unpaid invoices stay open: the offers the kept Tax Return jobs came from. */
export function keptOfferTokens(returns: readonly OpenJob[]): Set<string> {
  const out = new Set<string>()
  for (const r of returns) if (r.source_offer_token) out.add(r.source_offer_token)
  return out
}

/** An invoice that belongs to a part of a kept offer's payment plan is not cancelled by the closing. */
export function belongsToKeptOffer(row: { tranche_offer_token?: string | null }, tokens: ReadonlySet<string>): boolean {
  return !!row.tranche_offer_token && tokens.has(row.tranche_offer_token)
}

/** "Tax Return 2026" from the job's name, else "Tax Return" — for the lines staff read. */
export function returnLabel(j: OpenJob): string {
  const m = /^(Tax Return(?: One-Time)?(?: 20\d{2})?)/.exec(j.service_name ?? '')
  return m ? m[1] : j.service_type
}

/** The text of the marker note. */
export function waitsNote(returns: readonly OpenJob[]): string {
  const labels = returns.map(returnLabel).join(', ')
  return `${CLOSING_WAITS_MARKER}: the closure job is finished, but the company stays open (portal on) until ${labels} ${returns.length === 1 ? 'is' : 'are'} filed. It closes by itself then.`
}

export function hasWaitsMarker(body: string | null | undefined): boolean {
  return (body ?? '').includes(CLOSING_WAITS_MARKER)
}
