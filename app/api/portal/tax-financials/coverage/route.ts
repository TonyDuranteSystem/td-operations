/**
 * POST /api/portal/tax-financials/coverage
 *   { account_id, tax_year, question_key, answer: 'no_activity' | 'had_activity' }
 *
 * Records the client's answer to a coverage question (Slice 9 §3.4):
 * "no_activity" (account opened later / closed earlier / dormant) completes
 * the dataset; "had_activity" means the export is incomplete — the UI guides
 * the client to delete the file and re-export the full period, and the
 * attestation stays blocked until they do.
 *
 * Stored in tax_return_submissions.financials_meta.coverage_answers.
 * OWNER-ONLY; post-confirm locked.
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
    const questionKey = String(body.question_key ?? '')
    const answer = String(body.answer ?? '')

    if (!accountId || !Number.isInteger(taxYear) || !questionKey || !['no_activity', 'had_activity'].includes(answer)) {
      return NextResponse.json({ error: 'account_id, tax_year, question_key and a valid answer required' }, { status: 400 })
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
    // LOCK — evaluated on the LATEST submission for the account+year, NOT on the
    // `completed` row above (2026-08-03, bug-hunter finding). The coverage
    // answers still WRITE to the completed row, but the lock must be read the
    // same way every other write route and the GET's banner read it, or an
    // account carrying more than one row for a year gets a page that says
    // "editable" and a refusal that says "locked" (or the reverse).
    const { data: lockRow } = await db
      .from('tax_return_submissions')
      .select('review_status')
      .eq('account_id', accountId)
      .eq('tax_year', taxYear)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const lockStatus = (lockRow?.review_status ?? null) as string | null
    if (lockStatus !== null && !isClientEditable(lockStatus as never)) {
      return NextResponse.json({ error: 'Your submission is locked (under review or already confirmed) — ask us to reopen it first.' }, { status: 409 })
    }

    const meta = (sub.financials_meta ?? {}) as Record<string, unknown>
    const coverageAnswers = (meta.coverage_answers ?? {}) as Record<string, unknown>
    coverageAnswers[questionKey] = { answer, at: new Date().toISOString() }

    const { error } = await db
      .from('tax_return_submissions')
      .update({ financials_meta: { ...meta, coverage_answers: coverageAnswers } })
      .eq('id', sub.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ recorded: true })
  } catch (err) {
    console.error('[tax-financials] coverage answer failed:', err)
    return NextResponse.json({ error: 'Could not save your answer — please try again.' }, { status: 500 })
  }
}
