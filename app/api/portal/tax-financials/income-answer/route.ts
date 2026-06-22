/**
 * POST /api/portal/tax-financials/income-answer
 *   { account_id, tax_year, answer: 'earn_spend' | 'parked_only' }
 *
 * Records the client's answer to the targeted income question (dev_task
 * 95127bb2). It fires only when there is meaningful foreign-currency /
 * cross-account movement — evidence of an account we may not see. The answer
 * must be recorded before accept-as-is, so finalizing never silently ships
 * understated income (income flows to partners' home-country returns).
 *
 *   parked_only  → "I only convert and move it here" (no unseen activity).
 *   earn_spend   → "I also earn or spend there" — recorded + surfaced to staff
 *                  for K-1 follow-up; the client may still accept-as-is (they
 *                  owe no US tax and own the responsibility).
 *
 * Stored in tax_return_submissions.financials_meta.income_attestation.
 * OWNER-ONLY; locked once the submission is under review / confirmed.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAccountOwner } from '@/lib/portal/owner-access'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const accountId = String(body.account_id ?? '')
    const taxYear = Number(body.tax_year)
    const answer = String(body.answer ?? '')

    if (!accountId || !Number.isInteger(taxYear) || !['earn_spend', 'parked_only'].includes(answer)) {
      return NextResponse.json({ error: 'account_id, tax_year and a valid answer required' }, { status: 400 })
    }
    if (!(await isAccountOwner(user, accountId))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const { isClientEditable } = await import('@/lib/tax/review-status')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any // financials_meta not yet in database.types.ts
    const { data: sub } = await db
      .from('tax_return_submissions')
      .select('id, review_status, financials_meta')
      .eq('account_id', accountId)
      .eq('tax_year', taxYear)
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!sub) return NextResponse.json({ error: 'No submission found for this year.' }, { status: 404 })
    if (sub.review_status !== null && !isClientEditable(sub.review_status)) {
      return NextResponse.json({ error: 'Your submission is locked (under review or already confirmed) — ask us to reopen it first.' }, { status: 409 })
    }

    const meta = (sub.financials_meta ?? {}) as Record<string, unknown>
    const { error } = await db
      .from('tax_return_submissions')
      .update({ financials_meta: { ...meta, income_attestation: { answer, at: new Date().toISOString() } } })
      .eq('id', sub.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ recorded: true })
  } catch (err) {
    console.error('[tax-financials] income answer failed:', err)
    return NextResponse.json({ error: 'Could not save your answer — please try again.' }, { status: 500 })
  }
}
