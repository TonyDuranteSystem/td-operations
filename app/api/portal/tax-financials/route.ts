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
    const { coverageQuestions, unansweredCoverage, incompleteCoverage } = await import('@/lib/tax/coverage')
    const answers = (sub?.financials_meta?.coverage_answers ?? {}) as import('@/lib/tax/coverage').CoverageAnswers
    const covQs = coverageQuestions((sources ?? []).map(r => ({ bank_name: r.bank_name, account_type: r.account_type, transaction_date: r.transaction_date })), taxYear)
    const coverage = {
      questions: covQs.map(q => ({ ...q, answer: answers[q.key]?.answer ?? null })),
      unanswered: unansweredCoverage(covQs, answers).length,
      incomplete: incompleteCoverage(covQs, answers).length,
    }

    // Flexible expense buckets (#2) — the live catalog list the review groups by
    // and the "add a bucket" field offers.
    const { getExpenseBuckets, isOperatingExpenseRow, bucketSlugForRow, OTHER_BUCKET_LABEL } = await import('@/lib/tax/expense-buckets')
    const buckets = await getExpenseBuckets(db)

    // Operating-expense breakdown by accountant bucket (Luca: "more detail in the
    // P&L"). Matches the P&L's Operating-expenses composition: outflows booked
    // expense/fee PLUS uncategorized outflows (which default to business expense).
    // COGS + distributions are shown on their own lines, so excluded here.
    const bucketLabelMap = new Map(buckets.map(b => [b.slug, b.label]))
    const validSlugs = new Set(buckets.map(b => b.slug))
    const breakdownMap = new Map<string, number>()
    for (const r of uncatRows) {
      const amt = Number(r.amount)
      if (!isOperatingExpenseRow(r.category as string | null, amt)) continue
      const slug = bucketSlugForRow(r.ai_bucket, validSlugs)
      breakdownMap.set(slug, (breakdownMap.get(slug) ?? 0) + Math.abs(amt))
    }
    // slug travels with each line so the client can lazy-load that category's
    // transactions on click (Luca's drill-down, dev_task 1bee0ffe).
    const expense_breakdown = Array.from(breakdownMap.entries())
      .map(([slug, total]) => ({ slug, label: bucketLabelMap.get(slug) ?? OTHER_BUCKET_LABEL, total }))
      .sort((a, b) => b.total - a.total)

    // Ingestion status — the financials are computed on demand from
    // bank_transactions, which land asynchronously as each per-file
    // ingest_bank_statement job completes (a busy account's full year of PDF
    // statements takes ~45 min via AI extraction). Without this, the page
    // renders a misleading all-zeros P&L while jobs are still running and the
    // client thinks the tool is broken (Luca QA, 2026-06-25). We surface the
    // in-flight + failed counts so the UI can show "still preparing" instead of
    // fake zeros, and so attestation is blocked until ingestion is complete.
    // tax_year is stored as a JSON number in the payload → compare as text.
    const { data: ingestJobs } = await supabaseAdmin
      .from('job_queue')
      .select('status, result, payload')
      .eq('job_type', 'ingest_bank_statement')
      .eq('account_id', accountId)
      .in('status', ['pending', 'processing', 'failed', 'completed'])
    // Count by distinct FILE (payload.path), not by job: the stuck-job reaper
    // re-enqueues, so one file can have several rows (a merged file Luca uploaded
    // had 3 failed rows). Counting jobs told the client "3 files couldn't be
    // read" for 1 file. A file is DONE if ANY of its jobs completed successfully
    // (result.ok !== false on a completed row) — earlier failed/retried attempts
    // for that same path are then irrelevant. ('cancelled' is excluded by the
    // query above — superseded enqueues must not count as failures.)
    const byPath = new Map<string, { succeeded: boolean; pending: boolean; failed: boolean }>()
    for (const j of (ingestJobs ?? []) as Array<{ status: string; result: { ok?: boolean } | null; payload: { tax_year?: number | string; path?: string } | null }>) {
      // Scope to THIS tax year (the account may have statements for other years).
      if (String(j.payload?.tax_year ?? '') !== String(taxYear)) continue
      const path = j.payload?.path
      if (!path) continue
      const e = byPath.get(path) ?? { succeeded: false, pending: false, failed: false }
      if (j.status === 'completed' && j.result?.ok !== false) e.succeeded = true
      else if (j.status === 'pending' || j.status === 'processing') e.pending = true
      // Unreadable file → completes with ok:false; transient/throw → 'failed'.
      else if (j.status === 'failed' || (j.status === 'completed' && j.result?.ok === false)) e.failed = true
      byPath.set(path, e)
    }
    let ingestPending = 0
    let ingestFailed = 0
    for (const e of Array.from(byPath.values())) {
      if (e.succeeded) continue // the file made it in — ignore earlier attempts
      if (e.pending) ingestPending++
      else if (e.failed) ingestFailed++
    }

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
    // text-only "still finishing automatically" note during backoff waits —
    // never a control (review cond.: a stopped client run must be VISIBLE).
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
