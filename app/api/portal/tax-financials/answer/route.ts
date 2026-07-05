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
    // Bulk mode (multi-group one-tap, 2026-07-05): books rows but NEVER writes
    // learned rules — one lazy sweep must not become permanent per-merchant
    // memory. Distinct notes tag = undo route's guard.
    const isBulk = body.bulk === true
    const groupLabels: string[] = Array.isArray(body.group_labels) ? body.group_labels.map(String).slice(0, 50) : []

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
    // meter — captured BEFORE the update overwrites the notes. Chunked ×200: a
    // single .in() with ~950+ ids overflows the PostgREST URL and 500s, and the
    // request cap above is 2000.
    const aiPre: Array<{ id: string; category: string; notes: string }> = []
    for (let i = 0; i < transactionIds.length; i += 200) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: preAiRows, error: preErr } = await (supabaseAdmin as any)
        .from('bank_transactions')
        .select('id, category, notes')
        .eq('account_id', accountId)
        .eq('tax_year', taxYear)
        .in('id', transactionIds.slice(i, i + 200))
        .like('notes', 'ai:high%')
      if (preErr) console.error('[tax-financials] telemetry pre-select failed (answer continues):', preErr.message)
      aiPre.push(...((preAiRows ?? []) as Array<{ id: string; category: string; notes: string }>))
    }

    // Option B (2026-06-18): the owner can re-decide ANY business-booked charge
    // (expense/fee/cogs/income/uncategorized) — and undo a prior client decision
    // (distribution/contribution). We never clobber an auto-detected internal
    // transfer ('conversion') via a merchant flip. 'refund' is re-answerable (a
    // mis-booked refund must be correctable). Chunked ×200; partial-failure
    // contract: attestation reset + telemetry + learning still run for whatever
    // DID change before the error is reported — a stale attestation over
    // changed rows would be worse than the failed chunk.
    const updated: Array<{ id: string; description: string | null; counterparty: string | null; amount: number | string }> = []
    let updateError: string | null = null
    for (let i = 0; i < transactionIds.length; i += 200) {
      const { data, error } = await supabaseAdmin
        .from('bank_transactions')
        .update({ category: mapped.category, subcategory: mapped.subcategory, notes: isBulk ? `manual: bulk client answer (${answer})` : `manual: client answer (${answer})` })
        .eq('account_id', accountId)
        .eq('tax_year', taxYear)
        // Bulk only books rows still awaiting a decision — never stomps prior
        // bookings (keeps undo exact: prior state uniformly 'uncategorized').
        .in('category', isBulk ? ['uncategorized'] : ['uncategorized', 'expense', 'fee', 'cogs', 'income', 'distribution', 'contribution', 'refund'])
        .in('id', transactionIds.slice(i, i + 200))
        .select('id, description, counterparty, amount')
      if (error) { updateError = error.message; break }
      updated.push(...((data ?? []) as typeof updated))
    }

    const changed = updated.length
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

      // Bulk audit trail (fire-and-forget).
      if (isBulk) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (supabaseAdmin as any).from('action_log').insert({
            actor: user.email ?? 'client',
            action_type: 'bulk_group_answer',
            table_name: 'bank_transactions',
            record_id: accountId,
            account_id: accountId,
            summary: `Client bulk answer: ${changed} row(s) booked as ${mapped.category} across ${groupLabels.length || 'several'} group(s)`,
            details: { tax_year: taxYear, answer, count: changed, group_labels: groupLabels },
          })
        } catch (e) {
          console.error('[tax-financials] bulk audit log failed (answer saved fine):', e)
        }
      }

      // LEARN a per-client rule from this answer so the same merchant
      // auto-categorizes next year / on re-runs (the engine applies per-client
      // rules before global ones). Fire-and-forget: a learning failure must
      // NEVER break the client's answer. NEVER on bulk: permanent per-merchant
      // memory requires a per-merchant decision, not a sweep.
      if (!isBulk) try {
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

    if (updateError) {
      // Post-steps already ran for the rows that DID change; report honestly.
      console.error('[tax-financials] answer partially failed:', updateError)
      return NextResponse.json(
        { error: `Saved ${changed} of ${transactionIds.length} transactions — please retry to finish the rest.`, updated: changed },
        { status: 500 },
      )
    }
    return NextResponse.json({ updated: changed })
  } catch (err) {
    console.error('[tax-financials] answer failed:', err)
    return NextResponse.json({ error: 'Could not save your answer — please try again.' }, { status: 500 })
  }
}
