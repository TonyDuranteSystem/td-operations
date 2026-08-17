/**
 * GET /api/portal/tax-financials/prior-return-carry-check?account_id=&tax_year=
 *
 * STAFF ONLY. Read-only preview: is there a trustworthy prior year to carry
 * beginning balances FROM, and what would the carried figures be? Never
 * writes. Deliberately a separate, explicit-click action — NOT embedded in
 * the main financials view load — so merely opening a client's review screen
 * never triggers the (relatively expensive) prior-year computation this
 * requires (round-2/3 bug-hunter performance finding).
 */

import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const url = new URL(request.url)
  const accountId = url.searchParams.get('account_id')
  const taxYear = Number(url.searchParams.get('tax_year'))
  if (!accountId || !Number.isInteger(taxYear)) {
    return NextResponse.json({ error: 'account_id and tax_year required' }, { status: 400 })
  }

  try {
    // Round-5 bug-hunter blocker: MUST use the canonical resolver, not a raw
    // "newest row, any status" query — that exact anti-pattern already caused
    // a documented production incident on this same table (see
    // lib/tax/resolve-submission.ts's own history) and is exactly what the
    // sibling prior-return upload route was fixed to stop doing. A stray
    // pending/opened row (a resent, never-filled form) newer than the real
    // completed/reviewed submission would otherwise silently become the
    // target of a correction that never reaches the client's real file.
    const { resolveClientSubmission } = await import('@/lib/tax/resolve-submission')
    const sub = await resolveClientSubmission<{ id: string; prior_return_extracted: import('@/lib/tax/prior-return-case').PriorReturnCaseRecord | null; updated_at: string }>(
      db, accountId, taxYear, 'id, prior_return_extracted, updated_at',
    )
    if (!sub) {
      return NextResponse.json({ error: `No submission on file for this account for ${taxYear} yet.` }, { status: 404 })
    }

    const { getFinancialsView } = await import('@/lib/tax/financials-orchestration')
    const view = await getFinancialsView(accountId, taxYear)

    const { computeCarryFromBooks, autoCarryMayReplace } = await import('@/lib/tax/prior-return-correction')
    const check = await computeCarryFromBooks(accountId, taxYear, view.ownership.members)

    return NextResponse.json({
      ...check,
      may_auto_apply: autoCarryMayReplace(sub.prior_return_extracted ?? null),
      current: sub.prior_return_extracted ? { case: sub.prior_return_extracted.case, status: sub.prior_return_extracted.status } : null,
      expected_updated_at: sub.updated_at,
    })
  } catch (err) {
    console.error('[tax-financials] prior-return-carry-check failed:', err)
    return NextResponse.json({ error: 'Could not check for a carry-forward opportunity — please try again.' }, { status: 500 })
  }
}
