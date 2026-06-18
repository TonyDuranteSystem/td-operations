/**
 * POST /api/portal/tax-financials/answer
 *   { account_id, tax_year, transaction_ids, answer }
 *
 * The client answers one pattern-grouped question (Slice 8 §3.6) — the answer
 * applies to every transaction in the group. Written with a 'manual:' note so
 * the categorization engine NEVER overwrites a client's answer on re-runs.
 * Only uncategorized rows are touched (the ids are re-filtered server-side).
 *
 * OWNER-ONLY; refused after confirm (post-confirm lock).
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
    const transactionIds = Array.isArray(body.transaction_ids) ? body.transaction_ids.map(String) : []
    const answer = String(body.answer ?? '')

    if (!accountId || !Number.isInteger(taxYear) || transactionIds.length === 0 || !answer) {
      return NextResponse.json({ error: 'account_id, tax_year, transaction_ids and answer required' }, { status: 400 })
    }
    if (transactionIds.length > 2000) {
      return NextResponse.json({ error: 'Too many transactions in one answer.' }, { status: 400 })
    }
    if (!(await isAccountOwner(user, accountId))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const { categoryForAnswer } = await import('@/lib/tax/question-groups')
    const mapped = categoryForAnswer(answer)
    if (!mapped) return NextResponse.json({ error: 'Unknown answer choice.' }, { status: 400 })

    // Post-confirm lock — same rule as delete.
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

    const { data: updated, error } = await supabaseAdmin
      .from('bank_transactions')
      .update({ category: mapped.category, subcategory: mapped.subcategory, notes: `manual: client answer (${answer})` })
      .eq('account_id', accountId)
      .eq('tax_year', taxYear)
      .eq('category', 'uncategorized')
      .in('id', transactionIds)
      .select('id, description, counterparty, amount')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const changed = (updated ?? []).length
    if (changed > 0) {
      // The data changed — a prior attestation no longer covers it (QA finding).
      const { resetFinancialsAttestation } = await import('@/lib/tax/attestation')
      await resetFinancialsAttestation(accountId, taxYear, `answer applied to ${changed} transactions`)

      // LEARN a per-client rule from this answer so the same merchant
      // auto-categorizes next year / on re-runs (the engine applies per-client
      // rules before global ones). Fire-and-forget: a learning failure must
      // NEVER break the client's answer.
      try {
        const { upsertLearnedMerchantRules, makeSupabaseRuleStore } = await import('@/lib/tax/learned-rules')
        await upsertLearnedMerchantRules(
          makeSupabaseRuleStore(supabaseAdmin),
          accountId,
          (updated ?? []) as Array<{ description: string | null; counterparty: string | null; amount: number | string }>,
          mapped.category,
          mapped.subcategory,
          user.email ?? 'client',
        )
      } catch (learnErr) {
        console.error('[tax-financials] learn-rule failed (non-fatal):', learnErr)
      }
    }

    return NextResponse.json({ updated: changed })
  } catch (err) {
    console.error('[tax-financials] answer failed:', err)
    return NextResponse.json({ error: 'Could not save your answer — please try again.' }, { status: 500 })
  }
}
