/**
 * POST /api/portal/tax-financials/period-answer
 *   { account_id, tax_year, loc_codes, choice, scope, period_start?, period_end?,
 *     expected_row_count, expected_dollar_total }
 *
 * The CLIENT answers one location card ("Were you in Italy Feb–Aug?" /
 * "Everything in Spain?") — Phase B2's client flip of the staff route
 * (`app/api/tools/pnl/[id]/period-answer`). The sweep core is the books twin
 * (`lib/tax/books-location-answer.ts`): same five guards, account+year scope,
 * actor_role='client'. Country answers also become the STANDING account
 * policy — replayed automatically next year.
 *
 * OWNER-ONLY; refused after confirm (post-confirm lock); resets attestation.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAccountOwner } from '@/lib/portal/owner-access'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const LOC_CODE_RE = /^[A-Z]{2}$/

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => ({})) as {
      account_id?: string; tax_year?: number; loc_codes?: string[]
      choice?: string; scope?: string; period_start?: string; period_end?: string
      expected_row_count?: number; expected_dollar_total?: number
    }
    const accountId = String(body.account_id ?? '')
    const taxYear = Number(body.tax_year)
    const locCodes = Array.isArray(body.loc_codes) ? body.loc_codes.filter(c => typeof c === 'string' && LOC_CODE_RE.test(c)) : []
    const choice = body.choice
    const scope: 'period' | 'country' = body.scope === 'country' ? 'country' : 'period'
    if (!accountId || !Number.isInteger(taxYear) || locCodes.length === 0
      || (choice !== 'business' && choice !== 'personal')
      || typeof body.expected_row_count !== 'number' || typeof body.expected_dollar_total !== 'number') {
      return NextResponse.json({ error: 'account_id, tax_year, loc_codes, choice (business|personal), expected_row_count and expected_dollar_total are required.' }, { status: 400 })
    }
    if (scope === 'period' && (!body.period_start || !body.period_end)) {
      return NextResponse.json({ error: 'period_start and period_end are required.' }, { status: 400 })
    }
    if (!(await isAccountOwner(user, accountId))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    // Post-confirm lock — same rule as the group-answer route.
    const { isClientEditable } = await import('@/lib/tax/review-status')
    const { data: sub } = await supabaseAdmin
      .from('tax_return_submissions')
      .select('review_status')
      .eq('account_id', accountId)
      .eq('tax_year', taxYear)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const rs = sub?.review_status ?? null
    if (rs !== null && !isClientEditable(rs as never)) {
      return NextResponse.json({ error: 'Your submission is locked (under review or already confirmed) — ask us to reopen it before changing answers.' }, { status: 409 })
    }

    const { applyBooksLocationAnswer } = await import('@/lib/tax/books-location-answer')
    const result = await applyBooksLocationAnswer({
      accountId,
      taxYear,
      locCodes,
      choice,
      scope,
      periodStart: body.period_start,
      periodEnd: body.period_end,
      actorId: user.email ?? user.id,
      actorRole: 'client',
      expected: { rowCount: body.expected_row_count, dollarTotal: body.expected_dollar_total },
    })

    switch (result.status) {
      case 'count_mismatch':
        return NextResponse.json({
          error: 'The transactions in this period changed since the screen loaded — review the updated numbers and confirm again.',
          fresh: result.fresh,
        }, { status: 409 })
      case 'nothing_left':
        return NextResponse.json({ error: 'Nothing left to book in this period (it may already be answered).' }, { status: 409 })
      case 'ok': {
        try {
          const { resetFinancialsAttestation } = await import('@/lib/tax/attestation')
          await resetFinancialsAttestation(accountId, taxYear, `client ${scope} answer swept ${result.swept} transactions`)
        } catch (e) {
          console.error('[portal period-answer] attestation reset failed:', e)
        }
        return NextResponse.json({
          ok: true,
          batch_id: result.batchId,
          swept: result.swept,
          skipped_manual: result.skippedManual,
          skipped_ineligible: result.skippedIneligible,
        })
      }
    }
  } catch (err) {
    console.error('[portal period-answer] failed:', err)
    return NextResponse.json({ error: 'Could not book the period — please try again.' }, { status: 500 })
  }
}
