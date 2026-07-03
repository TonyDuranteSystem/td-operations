/**
 * TD Communication — Phase 13 earning-recognition chokepoint helpers.
 *
 * Kept in a tiny module (deps: supabaseAdmin only, like sla.ts) so the recognition
 * chokepoints in pipeline-queries / concept-actions / deliverables-queries and the
 * worker-attribution at brand-audit can import it WITHOUT an import cycle back
 * through revenue-queries.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/** The partner-scope value that marks a partner as a TD Communication worker. */
export const TD_COMM_SCOPE = 'td_communication'

/**
 * Resolve THE TD Communication worker partner (Cris) — the default assignee for a
 * new enrollment's `worker_partner_id`. Resolves by scope (future-proof if the
 * partner's email changes) and THROWS unless exactly one active partner matches,
 * so a mis-provisioned environment fails loudly rather than mis-attributing money.
 * Callers at the enrollment insert site catch this so it can never break enrollment.
 */
export async function resolveDefaultCommWorker(): Promise<string> {
  const { data, error } = await db
    .from('client_partners')
    .select('id, status')
    .contains('partner_scope', [TD_COMM_SCOPE])
  if (error) throw new Error(error.message)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const active = (data ?? []).filter((p: any) => p.status !== 'inactive')
  if (active.length !== 1) {
    throw new Error(
      `resolveDefaultCommWorker: expected exactly 1 active ${TD_COMM_SCOPE} partner, found ${active.length}`,
    )
  }
  return active[0].id
}

/**
 * Recognize an enrollment's earning: stamp `earning_locked_at` the FIRST time the
 * project reaches approved/delivered. Set-once (`.is('earning_locked_at', null)`
 * TOCTOU guard) and NEVER throws — recognition must not fail the caller's status
 * write (same fire-and-forget contract as ensureDeadlineAt).
 */
export async function lockEarningIfEligible(enrollmentId: string): Promise<void> {
  try {
    await db
      .from('td_comm_enrollments')
      .update({ earning_locked_at: new Date().toISOString() })
      .eq('id', enrollmentId)
      .is('earning_locked_at', null)
  } catch (err) {
    console.warn('[td-comm] lockEarningIfEligible failed (non-fatal):', err)
  }
}
