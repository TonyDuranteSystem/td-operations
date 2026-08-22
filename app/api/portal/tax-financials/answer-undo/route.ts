/**
 * POST /api/portal/tax-financials/answer-undo
 *   { account_id, tax_year, transaction_ids }
 *
 * Undo a BULK answer (OWNER-ONLY; refused after confirm — same lock as
 * answer). Bulk answers only ever book rows that were 'uncategorized', so
 * undo is exact: back to uncategorized. The notes guard ('manual: bulk %')
 * is server-side — client-supplied ids can never revert an individually-
 * answered or AI-booked row.
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
    if (!accountId || !Number.isInteger(taxYear) || transactionIds.length === 0) {
      return NextResponse.json({ error: 'account_id, tax_year and transaction_ids required' }, { status: 400 })
    }
    if (transactionIds.length > 2000) {
      return NextResponse.json({ error: 'Too many transactions in one undo.' }, { status: 400 })
    }
    if (!(await isAccountOwner(user, accountId))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    // Post-confirm lock — same rule as answer.
    // ONE resolver for which row is the client's file (see resolve-submission.ts):
    // the newest with real data. The old "newest of ANY status" let an unfilled
    // pending/opened form outrank the real submission and unlock it.
    const { resolveEditability } = await import('@/lib/tax/resolve-submission')
    const { editable: canEdit } = await resolveEditability(supabaseAdmin, accountId, taxYear)
    if (!canEdit) {
      return NextResponse.json({ error: 'Your submission is locked (under review or already confirmed) — ask us to reopen it before changing answers.' }, { status: 409 })
    }

    // Hard-stop parity (2026-08-21, round-3 bug-hunter minor finding): the
    // forward answer route already refuses on a structural problem; undo had
    // no such check, an asymmetry with what "the whole categorization queue
    // is blocked" is supposed to mean even though undo only reverts rows to
    // uncategorized (no new output) and every display surface stays hidden
    // regardless.
    const { getAccountStructuralProblem } = await import('@/lib/tax/financials-orchestration')
    if (await getAccountStructuralProblem(accountId, taxYear)) {
      return NextResponse.json({ error: 'This year has an unresolved data problem (an unreadable statement, or a missing-months question) — fix that first before changing anything else.' }, { status: 422 })
    }

    let reverted = 0
    for (let i = 0; i < transactionIds.length; i += 200) {
      const { data, error } = await supabaseAdmin
        .from('bank_transactions')
        .update({ category: 'uncategorized', subcategory: null, notes: null })
        .eq('account_id', accountId)
        .eq('tax_year', taxYear)
        .like('notes', 'manual: bulk %')
        .in('id', transactionIds.slice(i, i + 200))
        .select('id')
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      reverted += (data ?? []).length
    }

    if (reverted > 0) {
      // The data changed — a prior attestation no longer covers it.
      const { resetFinancialsAttestation } = await import('@/lib/tax/attestation')
      await resetFinancialsAttestation(accountId, taxYear, `bulk answer undone on ${reverted} transactions`)
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabaseAdmin as any).from('action_log').insert({
          actor: user.email ?? 'client',
          action_type: 'bulk_group_answer_undo',
          table_name: 'bank_transactions',
          record_id: accountId,
          account_id: accountId,
          summary: `Client bulk answer undone: ${reverted} row(s) back to uncategorized`,
          details: { tax_year: taxYear, count: reverted },
        })
      } catch (e) {
        console.error('[tax-financials] undo audit log failed (undo saved fine):', e)
      }
    }

    return NextResponse.json({ ok: true, reverted })
  } catch (err) {
    console.error('[tax-financials] answer-undo failed:', err)
    return NextResponse.json({ error: 'Could not undo — please try again.' }, { status: 500 })
  }
}
