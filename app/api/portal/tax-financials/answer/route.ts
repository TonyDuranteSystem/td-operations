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

    // Override telemetry (Phase 0.5, 2026-07-03): AI-booked rows (notes
    // ai:high@vN) the client is about to re-answer are the PRODUCTION precision
    // meter — captured BEFORE the update overwrites the notes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: preAiRows } = await (supabaseAdmin as any)
      .from('bank_transactions')
      .select('id, category, notes')
      .eq('account_id', accountId)
      .eq('tax_year', taxYear)
      .in('id', transactionIds)
      .like('notes', 'ai:high%')
    const aiPre = (preAiRows ?? []) as Array<{ id: string; category: string; notes: string }>

    // Option B (2026-06-18): the owner can re-decide ANY business-booked charge
    // (expense/fee/cogs/income/uncategorized) — and undo a prior client decision
    // (distribution/contribution). We never clobber an auto-detected internal
    // transfer ('conversion') via a merchant flip.
    const { data: updated, error } = await supabaseAdmin
      .from('bank_transactions')
      .update({ category: mapped.category, subcategory: mapped.subcategory, notes: `manual: client answer (${answer})` })
      .eq('account_id', accountId)
      .eq('tax_year', taxYear)
      .in('category', ['uncategorized', 'expense', 'fee', 'cogs', 'income', 'distribution', 'contribution'])
      .in('id', transactionIds)
      .select('id, description, counterparty, amount')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const changed = (updated ?? []).length
    if (changed > 0) {
      // Override telemetry write (fire-and-forget): only when the answer CHANGED
      // an AI-applied category — same-category confirmations are agreement.
      const updatedIds = new Set((updated ?? []).map(u => (u as { id: string }).id))
      const changedOverrides = aiPre.filter(o => updatedIds.has(o.id) && o.category !== mapped.category)
      if (changedOverrides.length > 0) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (supabaseAdmin as any).from('action_log').insert({
            actor: user.email ?? 'client',
            action_type: 'ai_categorization_override',
            table_name: 'bank_transactions',
            record_id: accountId,
            account_id: accountId,
            summary: `Client answer changed ${changedOverrides.length} AI-booked row(s): ${changedOverrides[0].category} → ${mapped.category} (${changedOverrides[0].notes})`,
            details: { tax_year: taxYear, count: changedOverrides.length, from_categories: changedOverrides.map(o => o.category), to_category: mapped.category, ai_versions: Array.from(new Set(changedOverrides.map(o => o.notes))) },
          })
        } catch (e) {
          console.error('[tax-financials] override telemetry failed (answer saved fine):', e)
        }
      }

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
