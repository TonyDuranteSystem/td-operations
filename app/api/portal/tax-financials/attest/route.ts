/**
 * POST /api/portal/tax-financials/attest — { account_id, tax_year }
 *
 * The financials attestation (Slice 8, master plan §3.7 + W5): the client
 * declares the generated P&L / Balance Sheet numbers are true. Stored ON THE
 * SUBMISSION ROW (confirmation_accepted + client_ip + client_user_agent +
 * a review_history entry) — it does NOT touch review_status; the existing
 * staff-review → approve → final-confirm machine is unchanged.
 *
 * HARD GATE: refused while any blocking gate fails (gate 6 — uncategorized
 * must be zero). OWNER-ONLY — attestation is signing-like, never a teammate's.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { fetchAllPaged } from '@/lib/bank-transactions-fetch'
import { isAccountOwner } from '@/lib/portal/owner-access'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    // Staff pass isAccountOwner, but the attestation is the CLIENT's act alone.
    if ((user.app_metadata as Record<string, unknown> | undefined)?.role !== 'client') {
      return NextResponse.json({ error: 'Only the client can attest their financials.' }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))
    const accountId = String(body.account_id ?? '')
    const taxYear = Number(body.tax_year)
    if (!accountId || !Number.isInteger(taxYear)) {
      return NextResponse.json({ error: 'account_id and tax_year required' }, { status: 400 })
    }
    if (!(await isAccountOwner(user, accountId))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    // The hard gate: every blocking gate must pass right now.
    const { getFinancialsView } = await import('@/lib/tax/financials-orchestration')
    const view = await getFinancialsView(accountId, taxYear)
    if (!view.canConfirm) {
      const blocked = view.gates.filter(g => g.blocking && g.status === 'fail').map(g => g.detail).join(' ')
      return NextResponse.json({ error: blocked || 'Not everything is verified yet.' }, { status: 422 })
    }

    // Income question (dev_task 95127bb2): when there is meaningful foreign /
    // cross-account movement, it must be answered before accept-as-is — so
    // finalizing never silently ships understated income. Either answer
    // unblocks; we only require that the client made the call.
    if (view.completeness.income_question.required && view.completeness.income_question.answer === null) {
      return NextResponse.json({ error: 'Please answer the question about your foreign / other-account activity first — then you can confirm.' }, { status: 422 })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any // financials_meta not yet in database.types.ts
    const { data: sub } = await db
      .from('tax_return_submissions')
      .select('id, review_history, confirmation_accepted, financials_meta')
      .eq('account_id', accountId)
      .eq('tax_year', taxYear)
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!sub) return NextResponse.json({ error: 'No submission found for this year.' }, { status: 404 })

    // Coverage must be resolved too (§3.4) — gate 1 can't see what an export
    // left out; the client's answers are the completeness guarantee.
    const { coverageQuestions, unansweredCoverage, incompleteCoverage } = await import('@/lib/tax/coverage')
    // Paginated — finalize-time coverage must see ALL rows, not the first 1000,
    // or a >1000-tx client could attest on a truncated month-span (the gate
    // that sends data toward filing).
    const covRows = await fetchAllPaged(async (from, to) => {
      const { data, error } = await supabaseAdmin
        .from('bank_transactions')
        .select('bank_name, account_type, transaction_date')
        .eq('account_id', accountId)
        .eq('tax_year', taxYear)
        .order('id', { ascending: true })
        .range(from, to)
      if (error) throw new Error(error.message)
      return data ?? []
    })
    const covQs = coverageQuestions(covRows, taxYear)
    const covAnswers = (sub.financials_meta?.coverage_answers ?? {}) as import('@/lib/tax/coverage').CoverageAnswers
    const unanswered = unansweredCoverage(covQs, covAnswers)
    const incomplete = incompleteCoverage(covQs, covAnswers)
    if (unanswered.length > 0) {
      return NextResponse.json({ error: `Please answer the remaining coverage question(s) first: ${unanswered.map(q => q.question).join(' ')}` }, { status: 422 })
    }
    if (incomplete.length > 0) {
      return NextResponse.json({ error: `You told us these exports are incomplete — please delete the file and upload the entire period: ${incomplete.map(q => q.bank_key).join(', ')}.` }, { status: 422 })
    }

    const history = Array.isArray(sub.review_history) ? sub.review_history : []
    const entry = {
      at: new Date().toISOString(),
      actor: 'client',
      event: 'financials_attested',
      note: `Client attested the generated P&L and Balance Sheet for ${taxYear} (gates: ${view.gates.map(g => `${g.id}=${g.status}`).join(', ')}).`,
    }
    const { error } = await supabaseAdmin
      .from('tax_return_submissions')
      .update({
        confirmation_accepted: true,
        client_ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
        client_user_agent: request.headers.get('user-agent') ?? null,
        review_history: [...history, entry],
      })
      .eq('id', sub.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Handoff (Slice 9 §3.7, fire-and-forget — the response never waits):
    // archive the confirmed Excel to Drive 3.Tax/{year} + create the staff
    // final-pass task. Failures are logged; staff still see the attestation
    // on the submission either way.
    void import('@/lib/tax/attest-handoff')
      .then(({ runAttestHandoff }) => runAttestHandoff(accountId, taxYear))
      .catch(e => console.error('[tax-financials] attest handoff failed:', e))

    return NextResponse.json({ attested: true, already: sub.confirmation_accepted === true })
  } catch (err) {
    console.error('[tax-financials] attest failed:', err)
    return NextResponse.json({ error: 'Could not record your confirmation — please try again.' }, { status: 500 })
  }
}
