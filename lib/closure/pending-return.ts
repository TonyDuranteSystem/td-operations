/**
 * A pending FINAL tax return holds a company's closing (dev job 0a60f416, part C — Antonio's rule, first decided 2026-10-15 as "choice B" in the Wrap-up design,
 * lib/closure/wrapup-facts.ts: an open Tax Return keeps the company Active until it reaches "TR Filed").
 *
 * Carasso: Company Closure + a Tax Return sold for 2026 and filed in 2027. When the closure job reaches "Closing" the system used to cancel every other open
 * service (the Tax Return too), cancel the unpaid invoices and turn the portal off. Now, when a Tax Return is still open:
 *   - the Tax Return, its to-dos, its tax deadlines and the unpaid invoices of ITS offer are left alone;
 *   - the company is NOT set to Closed and the portal stays on (the portal shows a company while it is Active or Suspended);
 *   - the rest of the closing is done, a marker note is left on the closure job, and the closure's own follow-up to-dos are created as always;
 *   - when the last such Tax Return is filed (or cancelled) the same closing completes — idempotent, the company becomes Closed then.
 *
 * THE STATE IS NEVER JUST "A NOTE EXISTS" (bug hunt 2026-11-19): a company is waiting only while the NEWEST marker on its closure job says so AND that job is
 * still finished at "Closing". Going back, cancelling the job, finishing again without waiting, or closing the company all end the wait — the last two by
 * writing a "CLOSING WAIT ENDED" note, so a later tax return (or a company brought back to Active) can never be closed by a stale marker.
 *
 * Pure: no database, no I/O. The reads and writes are in lib/operations/close-company.ts and lib/closure/closing-wait.ts.
 */
import { TAX_RETURN_SERVICES } from '@/lib/closure/wrapup-facts'
import { CLOSING_STEP_NAME } from '@/lib/closure/closing-step'

/** The note left on the closure job while the company waits for its final tax return. */
export const CLOSING_WAITS_MARKER = 'CLOSING WAITS FOR THE FINAL TAX RETURN'
/** The note that ENDS a wait (the company was closed, or the job was finished without waiting). */
export const CLOSING_ENDED_MARKER = 'CLOSING WAIT ENDED'
/** Matches both markers (database `ilike`): "CLOSING WAIT" + "S FOR…" / " ENDED". */
export const CLOSING_MARKER_LIKE = '%CLOSING WAIT%'

/** Statuses of a job that is still open (the same list the closing step uses). */
export const OPEN_JOB_STATUSES = ['active', 'on_hold', 'blocked'] as const

export interface OpenJob {
  id: string
  service_type: string
  status?: string | null
  stage?: string | null
  service_name?: string | null
  source_offer_token?: string | null
}

/**
 * A Tax Return parked at a "Terminated…" step (for example "Terminated - Non Payment") is a dead end, not a return being worked on: the job stays `active`
 * because that step does not complete it, so without this it would hold a closing forever. The Wrap-up panel (wrapup-facts.ts) already reads it the same way.
 */
export function isDeadEndStage(stage: string | null | undefined): boolean {
  return /^terminated/i.test((stage ?? '').trim())
}

/** The open jobs that HOLD the closing: an open Tax Return (either Tax Return job type) that is not at a dead-end step. */
export function holdingReturns<T extends OpenJob>(open: readonly T[]): T[] {
  return open.filter((j) => TAX_RETURN_SERVICES.includes(j.service_type) && !isDeadEndStage(j.stage))
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

/** The text of the marker note that starts a wait. */
export function waitsNote(returns: readonly OpenJob[]): string {
  const labels = returns.map(returnLabel).join(', ')
  return `${CLOSING_WAITS_MARKER}: the closure job is finished, but the company stays open (portal on) until ${labels} ${returns.length === 1 ? 'is' : 'are'} filed. It closes by itself then.`
}

/** The text of the marker note that ends a wait. */
export function endedNote(reason: string): string {
  return `${CLOSING_ENDED_MARKER}: ${reason}.`
}

export function hasWaitsMarker(body: string | null | undefined): boolean {
  return (body ?? '').includes(CLOSING_WAITS_MARKER)
}

export function hasEndedMarker(body: string | null | undefined): boolean {
  return (body ?? '').includes(CLOSING_ENDED_MARKER)
}

/** What the NEWEST marker on a closure job says. `notes` must be OLDEST FIRST. */
export function newestMarker(notes: ReadonlyArray<{ body: string | null }>): 'waits' | 'ended' | null {
  for (let i = notes.length - 1; i >= 0; i--) {
    if (hasEndedMarker(notes[i].body)) return 'ended'
    if (hasWaitsMarker(notes[i].body)) return 'waits'
  }
  return null
}

/**
 * Is this closure job still holding its company open? Yes only while the job is finished at "Closing" (going back reopens it, cancelling it ends it)
 * AND the newest marker on it says it waits (finishing again without waiting, or closing the company, wrote an end marker). `notes` OLDEST FIRST.
 */
export function isWaitingClosureJob(job: { status?: string | null; stage?: string | null }, notes: ReadonlyArray<{ body: string | null }>): boolean {
  return String(job.status ?? '').toLowerCase() === 'completed' && (job.stage ?? '').trim() === CLOSING_STEP_NAME && newestMarker(notes) === 'waits'
}
