/**
 * GET /api/portal/tax-financials?account_id=&tax_year=
 *
 * The financials view for the portal review screen (Slice 7/8): P&L draft,
 * balance sheet, six gate results, ownership resolution, per-file sources.
 * Computed on demand from bank_transactions — never stored.
 *
 * OWNER-ONLY (lib/portal/owner-access) — tax financials are non-delegable.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { fetchAllPaged } from '@/lib/bank-transactions-fetch'
import { isAccountOwner } from '@/lib/portal/owner-access'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const url = new URL(request.url)
    const accountId = url.searchParams.get('account_id')
    const taxYear = Number(url.searchParams.get('tax_year'))
    if (!accountId || !Number.isInteger(taxYear)) {
      return NextResponse.json({ error: 'account_id and tax_year required' }, { status: 400 })
    }
    if (!(await isAccountOwner(user, accountId))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const { getFinancialsView } = await import('@/lib/tax/financials-orchestration')
    const view = await getFinancialsView(accountId, taxYear)

    // Pattern-grouped questions for what's still uncategorized (Slice 8 —
    // one answer covers every transaction from the same merchant; the 5b
    // benchmark showed the top 25 merchant groups cover most of the residual).
    const { groupUncategorized } = await import('@/lib/tax/question-groups')
    // Paginated — the 1000-row cap would hide questions / undercount files for
    // any account with >1000 transactions in the year (same bug class as the
    // financials reads). `id` order keeps range pages from skipping rows.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any // ai_lean/ai_bucket + financials_meta not yet in database.types.ts
    const uncatRows = await fetchAllPaged<Record<string, unknown>>(async (from, to) => {
      // Option B + no-vanish (2026-06-18, Antonio/Luca): the review shows ALL
      // reviewable spend AND the owner's already-made decisions
      // (distribution=personal, contribution=owner-money-in) — so flagging a
      // charge NEVER makes it disappear; it just changes its shown state and can
      // be flipped back (Luca: "when you select it, it disappears right away —
      // you have to be really careful"). Only auto-detected internal transfers
      // ('conversion') are excluded (not an owner spend decision).
      const { data, error } = await db
        .from('bank_transactions')
        .select('id, description, counterparty, amount, currency, transaction_date, bank_name, ai_lean, ai_bucket, category, subcategory')
        .eq('account_id', accountId)
        .eq('tax_year', taxYear)
        // 'refund' included since 2026-07-05 — AI-booked refunds were invisible
        // in the review (no-vanish violation).
        .in('category', ['uncategorized', 'expense', 'fee', 'cogs', 'income', 'distribution', 'contribution', 'refund'])
        .order('id', { ascending: true })
        .range(from, to)
      if (error) throw new Error(error.message)
      return (data ?? []) as Record<string, unknown>[]
    })
    const questions = groupUncategorized(uncatRows.map(r => ({
      id: String(r.id),
      description: String(r.description ?? ''),
      counterparty: (r.counterparty as string | null) ?? null,
      amount: Number(r.amount),
      currency: (r.currency as string | null) ?? null,
      transaction_date: String(r.transaction_date ?? ''),
      bank_name: String(r.bank_name ?? ''),
      ai_lean: (r.ai_lean as string | null) ?? null,
      ai_bucket: (r.ai_bucket as string | null) ?? null,
      category: String(r.category ?? 'uncategorized'),
      subcategory: (r.subcategory as string | null) ?? null,
    })))

    // Per-file sources for the delete/replace cards (§6) + coverage below.
    const sources = await fetchAllPaged(async (from, to) => {
      const { data, error } = await supabaseAdmin
        .from('bank_transactions')
        .select('source_file_id, bank_name, account_type, transaction_date')
        .eq('account_id', accountId)
        .eq('tax_year', taxYear)
        .order('id', { ascending: true })
        .range(from, to)
      if (error) throw new Error(error.message)
      return data ?? []
    })
    const bySource = new Map<string, { bank_name: string; count: number; from: string; to: string }>()
    for (const r of sources ?? []) {
      const key = r.source_file_id ?? 'unknown'
      const cur = bySource.get(key)
      if (!cur) bySource.set(key, { bank_name: r.bank_name, count: 1, from: r.transaction_date, to: r.transaction_date })
      else {
        cur.count++
        if (r.transaction_date < cur.from) cur.from = r.transaction_date
        if (r.transaction_date > cur.to) cur.to = r.transaction_date
      }
    }

    // Current attestation state — reset by any data mutation (QA finding) —
    // and the coverage answers (financials_meta, Slice 9). (`db` hoisted above.)
    const { data: sub } = await db
      .from('tax_return_submissions')
      .select('confirmation_accepted, financials_meta')
      .eq('account_id', accountId)
      .eq('tax_year', taxYear)
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    // Coverage questions (§3.4): the months an export doesn't span — gate 1
    // can't see what a file left out; the client's answer closes the hole.
    const { coverageQuestions, missingBankQuestions, unansweredCoverage, incompleteCoverage } = await import('@/lib/tax/coverage')
    const answers = (sub?.financials_meta?.coverage_answers ?? {}) as import('@/lib/tax/coverage').CoverageAnswers
    const covTxs = (sources ?? []).map(r => ({ bank_name: r.bank_name, account_type: r.account_type, transaction_date: r.transaction_date }))
    // S2 slice 4 — banks known from LAST year with no rows this year become an
    // explicit question (the missing-Chase class), instead of a silent hole.
    const { data: priorBanks } = await supabaseAdmin
      .from('bank_transactions')
      .select('bank_name, account_type')
      .eq('account_id', accountId)
      .eq('tax_year', taxYear - 1)
      .limit(5000)
    const knownBankKeys = Array.from(new Set((priorBanks ?? []).map(r => `${r.bank_name} ${r.account_type ?? 'Checking'}`)))
    const covQs = [
      ...coverageQuestions(covTxs, taxYear),
      ...missingBankQuestions(knownBankKeys, covTxs, taxYear),
    ]
    const coverage = {
      questions: covQs.map(q => ({ ...q, answer: answers[q.key]?.answer ?? null })),
      unanswered: unansweredCoverage(covQs, answers).length,
      incomplete: incompleteCoverage(covQs, answers).length,
    }

    // Flexible expense buckets (#2) — the live catalog list the review groups by
    // and the "add a bucket" field offers.
    const { getExpenseBuckets, buildExpenseBreakdown } = await import('@/lib/tax/expense-buckets')
    const buckets = await getExpenseBuckets(db)

    // Operating-expense breakdown by accountant bucket (Luca: "more detail in the
    // P&L"). Matches the P&L's Operating-expenses composition: outflows booked
    // expense/fee PLUS uncategorized outflows (which default to business expense).
    // COGS + distributions are shown on their own lines, so excluded here.
    // slug travels with each line so the client can lazy-load that category's
    // transactions on click (Luca's drill-down, dev_task 1bee0ffe). Breakdown is
    // headline-consistent since S2 slice 6a (signed math incl. refunds).
    const expense_breakdown = buildExpenseBreakdown(
      uncatRows.map(r => ({ category: (r.category as string | null) ?? null, amount: Number(r.amount), ai_bucket: r.ai_bucket })),
      buckets,
    )

    // Ingestion status — per-FILE states via the shared helper (S2 slice 3;
    // the attest route enforces the same truth server-side). A file is DONE if
    // ANY of its jobs completed successfully; 'cancelled' never counts.
    const { listIngestFileStates, unresolvedFailedFiles } = await import('@/lib/tax/ingest-status')
    const fileStates = await listIngestFileStates(accountId, taxYear)
    const ingestPending = fileStates.filter(f => !f.succeeded && f.pending).length
    const ingestFailed = unresolvedFailedFiles(fileStates).length

    // Location-period + country cards (Phase B2, 2026-07-08): same pure
    // builder as the staff tool (lib/tax/location-cards.ts), fed from the
    // client's BOOKS — located rows (stamped by recategorizeAccountYear or
    // carried by Save-to-client), the account-scoped period answers, and the
    // standing account policies. Residence anchor = the account's declared
    // fiscal-residence country (same resolver the S4 sweep uses).
    let periods: unknown[] = []
    let country_cards: unknown[] = []
    let period_answers: unknown[] = []
    let residence_country: string | null = null
    try {
      const locatedRows = await fetchAllPaged<Record<string, unknown>>(async (from, to) => {
        const { data, error } = await db
          .from('bank_transactions')
          .select('id, transaction_date, description, counterparty, amount, category, notes, loc_code, loc_source')
          .eq('account_id', accountId)
          .eq('tax_year', taxYear)
          .not('loc_code', 'is', null)
          .order('id', { ascending: true })
          .range(from, to)
        if (error) throw new Error(error.message)
        return (data ?? []) as Record<string, unknown>[]
      })
      const { data: batchRows } = await db
        .from('pnl_period_answers')
        .select('id, loc_codes, period_start, period_end, choice, actor_role, row_count, dollar_total, created_at, undone_at, policy_revoked_at')
        .eq('account_id', accountId)
        .eq('tax_year', taxYear)
        .order('created_at', { ascending: false })
      const activeAnswers = ((batchRows ?? []) as Array<Record<string, unknown>>).filter(b => !b.undone_at)
      const { data: acctPolicies } = await db
        .from('account_location_policies')
        .select('loc_code')
        .eq('account_id', accountId)
        .eq('active', true)
      const { resolveAccountResidenceIso } = await import('@/lib/tax/country-policy-sweep')
      residence_country = await resolveAccountResidenceIso(accountId)
      const { buildLocationCards } = await import('@/lib/tax/location-cards')
      const built = buildLocationCards({
        locatedRows: locatedRows.map(r => ({
          id: String(r.id),
          transaction_date: String(r.transaction_date ?? ''),
          description: (r.description as string | null) ?? null,
          counterparty: (r.counterparty as string | null) ?? null,
          amount: Number(r.amount),
          category: (r.category as string | null) ?? null,
          notes: (r.notes as string | null) ?? null,
          loc_code: (r.loc_code as string | null) ?? null,
          loc_source: (r.loc_source as string | null) ?? null,
        })),
        periodAnswers: activeAnswers.map(b => ({
          loc_codes: b.loc_codes as string[],
          period_start: String(b.period_start),
          period_end: String(b.period_end),
          policy_revoked_at: (b.policy_revoked_at as string | null) ?? null,
        })),
        accountPolicyCodes: ((acctPolicies ?? []) as Array<{ loc_code: string }>).map(p => p.loc_code),
        residenceCountry: residence_country,
        taxYear,
      })
      periods = built.periods
      country_cards = built.country_cards
      period_answers = activeAnswers
    } catch (e) {
      console.error('[tax-financials] location cards failed (view unaffected):', e)
    }

    // Self-healing AI chain state (Phase 3R): the client sees a neutral
    let aiState: string = 'idle'
    let aiRemaining = 0
    try {
      const { chainStateForScope } = await import('@/lib/jobs/chain-watchdog')
      const chain = await chainStateForScope({ jobType: 'recategorize_ai', accountId, taxYear })
      aiState = chain.state
      aiRemaining = chain.remaining
    } catch (e) {
      console.error('[tax-financials] chain state failed (view unaffected):', e)
    }

    return NextResponse.json({
      ...view,
      questions,
      coverage,
      expense_breakdown,
      buckets,
      ingestPending,
      ingestFailed,
      attested: sub?.confirmation_accepted === true,
      files: Array.from(bySource.entries()).map(([source_file_id, s]) => ({ source_file_id, ...s })),
      aiState,
      aiRemaining,
      periods,
      country_cards,
      period_answers,
      residence_country,
    })
  } catch (err) {
    console.error('[tax-financials] view failed:', err)
    return NextResponse.json({ error: 'Could not load your financials — please try again.' }, { status: 500 })
  }
}
