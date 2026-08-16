/**
 * POST /api/portal/tax-financials/prior-return-correction
 * Body: { account_id, tax_year, expected_updated_at, beginning_cash,
 *         beginning_cta, members: [{ contact_id, name, beginning_capital }] }
 *
 * STAFF ONLY. The human override: staff directly enter the true beginning
 * figures for a prior-year answer already known to be wrong — e.g. a filed
 * return that passed "readable and internally consistent" validation but is
 * factually incorrect. Deliberately unconditional: unlike the auto-carry
 * (prior-return-carry-confirm), this may replace ANY existing case/status,
 * including an already-"validated" one, because that IS the point (round-3
 * bug-hunter blocker 1 — an earlier plan's "mirror the existing guarded
 * route" language accidentally implied inheriting that route's refusal; this
 * route's contract is the opposite, by design, and explicit here).
 *
 * Every numeric field is REQUIRED in the request body — none is defaulted
 * server-side. A blank/omitted field is a 400, never silently read as 0
 * (round-2 finding: a form that defaults an unfilled field risks discarding a
 * previously-correct value through the "fix" door). The UI is responsible for
 * pre-filling the form from the CURRENT record before staff submit.
 */

import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { buildStaffCorrectionRecord } from '@/lib/tax/prior-return-case'
import { validateCorrectionPayload } from '@/lib/tax/prior-return-correction'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })

  const accountId = body.account_id
  const taxYear = Number(body.tax_year)
  const expectedUpdatedAt = body.expected_updated_at
  if (typeof accountId !== 'string' || !accountId || !Number.isInteger(taxYear) || typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt) {
    return NextResponse.json({ error: 'account_id, tax_year, and expected_updated_at are required.' }, { status: 400 })
  }
  const validated = validateCorrectionPayload(body)
  if ("error" in validated) return NextResponse.json({ error: validated.error }, { status: 400 })

  try {
    // Round-5 bug-hunter blocker: canonical resolver, not a raw "newest row,
    // any status" query — see prior-return-carry-check/route.ts for the full
    // rationale (this is the exact, already-documented, already-fixed-once
    // production bug class on this same table).
    const { resolveClientSubmission } = await import('@/lib/tax/resolve-submission')
    const sub = await resolveClientSubmission<{ id: string; updated_at: string }>(db, accountId, taxYear, 'id, updated_at')
    if (!sub) return NextResponse.json({ error: `No submission on file for this account for ${taxYear}.` }, { status: 404 })
    if (sub.updated_at !== expectedUpdatedAt) {
      return NextResponse.json({ error: 'STALE_EDIT', message: 'This record was changed by someone else since you loaded it — refresh and try again.' }, { status: 409 })
    }

    // Unmatched-against-current-roster names are impossible here by
    // construction (the UI pre-populates one row per currently-resolved
    // member) — unresolved_members stays empty; gate 7 would only ever flag a
    // member added to the roster AFTER this record was saved, which is
    // exactly the roster-drift case it exists to catch.
    const record = buildStaffCorrectionRecord(
      { beginning_cash: validated.value.beginning_cash, beginning_cta: validated.value.beginning_cta, members: validated.value.members, unresolved_members: [] },
      taxYear - 1,
      user?.email ?? 'staff',
      new Date().toISOString(),
    )

    // .eq('updated_at', expectedUpdatedAt) makes the concurrency check ATOMIC
    // — see prior-return-carry-confirm/route.ts for why a JS-only compare
    // isn't enough (round-4 minor finding).
    const { data: updated, error } = await db
      .from('tax_return_submissions')
      .update({ prior_return_extracted: record, updated_at: new Date().toISOString() })
      .eq('id', sub.id)
      .eq('updated_at', expectedUpdatedAt)
      .select('id')
    if (error) throw new Error(error.message)
    if (!updated || updated.length === 0) {
      return NextResponse.json({ error: 'STALE_EDIT', message: 'This record was changed by someone else since you loaded it — refresh and try again.' }, { status: 409 })
    }

    try {
      const { resetFinancialsAttestation } = await import('@/lib/tax/attestation')
      await resetFinancialsAttestation(accountId, taxYear, `prior-year beginning balances corrected by staff (${user?.email ?? 'staff'})`)
    } catch (e) {
      console.error('[tax-financials] attestation reset after prior-return-correction failed:', e)
    }

    return NextResponse.json({ ok: true, applied: { case: record.case, status: record.status } })
  } catch (err) {
    console.error('[tax-financials] prior-return-correction failed:', err)
    return NextResponse.json({ error: 'Could not save the correction — please try again.' }, { status: 500 })
  }
}
