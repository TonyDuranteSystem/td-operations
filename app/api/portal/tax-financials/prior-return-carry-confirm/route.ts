/**
 * POST /api/portal/tax-financials/prior-return-carry-confirm
 * Body: { account_id, tax_year, expected_updated_at }
 *
 * STAFF ONLY. Writes the auto-carry candidate ONCE. Re-computes fresh here —
 * never trusts a preview the client held onto from an earlier GET, since the
 * underlying books could have changed in between. Two guards:
 *  - autoCarryMayReplace: refuses unless the CURRENT prior_return_extracted is
 *    absent / a prior failed attempt / a we_filed-on_file we could never
 *    auto-read — never silently overwrites an authoritative answer (an
 *    already-validated upload, a first_year/never_filed declaration, or a
 *    standing carried_forward/staff_corrected record). To replace one of
 *    those, staff use prior-return-correction (the manual path), never this.
 *  - optimistic concurrency: expected_updated_at must match the submission
 *    row's CURRENT updated_at, or this refuses with a clear "changed by
 *    someone else, refresh and retry" rather than silently clobbering a
 *    concurrent edit (round-2 minor finding).
 */

import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const body = await request.json().catch(() => ({})) as { account_id?: string; tax_year?: number; expected_updated_at?: string }
  const { account_id: accountId, tax_year: taxYear, expected_updated_at: expectedUpdatedAt } = body
  if (!accountId || !Number.isInteger(taxYear) || !expectedUpdatedAt) {
    return NextResponse.json({ error: 'account_id, tax_year, and expected_updated_at are required.' }, { status: 400 })
  }

  try {
    // Round-5 bug-hunter blocker: canonical resolver, not a raw "newest row,
    // any status" query — see prior-return-carry-check/route.ts for the full
    // rationale (this is the exact, already-documented, already-fixed-once
    // production bug class on this same table).
    const { resolveClientSubmission } = await import('@/lib/tax/resolve-submission')
    const sub = await resolveClientSubmission<{ id: string; prior_return_extracted: import('@/lib/tax/prior-return-case').PriorReturnCaseRecord | null; updated_at: string }>(
      db, accountId, taxYear, 'id, prior_return_extracted, updated_at',
    )
    if (!sub) return NextResponse.json({ error: `No submission on file for this account for ${taxYear}.` }, { status: 404 })
    if (sub.updated_at !== expectedUpdatedAt) {
      return NextResponse.json({ error: 'STALE_EDIT', message: 'This record was changed by someone else since you loaded it — refresh and try again.' }, { status: 409 })
    }

    const { computeCarryFromBooks, autoCarryMayReplace } = await import('@/lib/tax/prior-return-correction')
    if (!autoCarryMayReplace(sub.prior_return_extracted ?? null)) {
      return NextResponse.json({ error: 'The current prior-year answer is already authoritative — it cannot be auto-replaced. Use the manual correction instead if it needs fixing.' }, { status: 409 })
    }

    const { getFinancialsView } = await import('@/lib/tax/financials-orchestration')
    const view = await getFinancialsView(accountId, taxYear)
    const check = await computeCarryFromBooks(accountId, taxYear, view.ownership.members)
    if (!check.offered || !check.candidate) {
      return NextResponse.json({ error: check.reason ?? 'No carry-forward candidate available.' }, { status: 409 })
    }

    // .eq('updated_at', expectedUpdatedAt) makes the concurrency check ATOMIC
    // (round-4 minor: the earlier version only compared updated_at in JS
    // before writing — two requests reading the same row before either wrote
    // would both pass that check and the second would silently win). A
    // concurrent write between the read above and here now matches ZERO rows
    // instead of overwriting; .select() lets us tell the difference from a
    // genuine DB error.
    const { data: updated, error } = await db
      .from('tax_return_submissions')
      .update({ prior_return_extracted: check.candidate, updated_at: new Date().toISOString() })
      .eq('id', sub.id)
      .eq('updated_at', expectedUpdatedAt)
      .select('id')
    if (error) throw new Error(error.message)
    if (!updated || updated.length === 0) {
      return NextResponse.json({ error: 'STALE_EDIT', message: 'This record was changed by someone else since you loaded it — refresh and try again.' }, { status: 409 })
    }

    try {
      const { resetFinancialsAttestation } = await import('@/lib/tax/attestation')
      await resetFinancialsAttestation(accountId, taxYear, 'prior-year beginning balances carried forward from corrected books')
    } catch (e) {
      console.error('[tax-financials] attestation reset after carry-confirm failed:', e)
    }

    return NextResponse.json({ ok: true, applied: { case: check.candidate.case, status: check.candidate.status } })
  } catch (err) {
    console.error('[tax-financials] prior-return-carry-confirm failed:', err)
    return NextResponse.json({ error: 'Could not apply the carry-forward — please try again.' }, { status: 500 })
  }
}
