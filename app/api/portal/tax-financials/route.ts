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
import { canonicalBankName } from '@/lib/tax/bank-identity'
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
        .select('id, description, counterparty, amount, currency, transaction_date, bank_name, ai_lean, ai_bucket, category, subcategory, notes')
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
    const toQuestionRow = (r: Record<string, unknown>) => ({
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
      // Carried ONLY so the suspected-member mark can be recovered; the note
      // itself never reaches the client.
      notes: (r.notes as string | null) ?? null,
    })
    const questions = groupUncategorized(uncatRows.map(toQuestionRow))

    // HUMAN-answered own_transfer rows come BACK into the review (2026-08-05,
    // VSV210 no-vanish fix): "Transfer between the company's own accounts" was
    // the only answer that vanished irreversibly — the category it books
    // ('conversion') is excluded above, so neither the client nor staff could
    // see or change a mis-tap. Re-included here under the STRICT note
    // predicate: only rows a person answered, NEVER the auto transfer-pair /
    // own-entity / zero-amount bookings (exposing those would flood every
    // review with internal plumbing — council blocker, 2026-08-05).
    //
    // Grouped SEPARATELY and key-suffixed: mixing them into the main rows
    // would let `mode(category)` mis-render a whole mixed-root group, and a
    // shared group_key would collide with the open group of the same merchant
    // (duplicate React keys + the bulk key-set would match both).
    const { isHumanOwnTransferNote } = await import('@/lib/tax/question-groups')
    const conversionRows = await fetchAllPaged<Record<string, unknown>>(async (from, to) => {
      const { data, error } = await db
        .from('bank_transactions')
        .select('id, description, counterparty, amount, currency, transaction_date, bank_name, ai_lean, ai_bucket, category, subcategory, notes')
        .eq('account_id', accountId)
        .eq('tax_year', taxYear)
        .eq('category', 'conversion')
        // Coarse DB-side cut; the exact three-prefix predicate runs in JS below
        // (PostgREST or() with parenthesised like-values is a documented
        // quoting minefield in this repo — one plain like + JS filter is safer).
        .like('notes', 'manual:%')
        .order('id', { ascending: true })
        .range(from, to)
      if (error) throw new Error(error.message)
      return (data ?? []) as Record<string, unknown>[]
    })
    const answeredOwnTransfers = conversionRows.filter(r => isHumanOwnTransferNote((r.notes as string | null) ?? null))
    if (answeredOwnTransfers.length > 0) {
      const { GROUP_KEY_SEP } = await import('@/lib/tax/question-groups')
      for (const g of groupUncategorized(answeredOwnTransfers.map(toQuestionRow))) {
        questions.push({ ...g, group_key: g.group_key + GROUP_KEY_SEP + 'own_transfer_answered' })
      }
    }

    // Per-file sources for the delete/replace cards (§6) + coverage below.
    type SourceRow = { source_file_id: string | null; bank_name: string; account_type: string | null; account_ref: string | null; transaction_date: string }
    const sources = await fetchAllPaged<SourceRow>(async (from, to) => {
      // account_ref is not yet in the generated types (prod DDL pending) — as-any
      // escape, same pattern as ai_lean/ai_bucket elsewhere in this route.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabaseAdmin as any)
        .from('bank_transactions')
        .select('source_file_id, bank_name, account_type, account_ref, transaction_date')
        .eq('account_id', accountId)
        .eq('tax_year', taxYear)
        .order('id', { ascending: true })
        .range(from, to)
      if (error) throw new Error(error.message)
      return (data ?? []) as SourceRow[]
    })
    const bySource = new Map<string, { bank_name: string; count: number; from: string; to: string }>()
    // Distinct accounts already on file (pick-your-account: the client reuses an
    // existing identity instead of retyping the number, so a typo can't re-split).
    const byAccount = new Map<string, { account_ref: string; bank: string; acct: string; count: number }>()
    for (const r of sources ?? []) {
      const key = r.source_file_id ?? 'unknown'
      const cur = bySource.get(key)
      if (!cur) bySource.set(key, { bank_name: canonicalBankName(r.bank_name), count: 1, from: r.transaction_date, to: r.transaction_date })
      else {
        cur.count++
        if (r.transaction_date < cur.from) cur.from = r.transaction_date
        if (r.transaction_date > cur.to) cur.to = r.transaction_date
      }
      const ref = (r as { account_ref?: string | null }).account_ref
      if (ref) {
        const a = byAccount.get(ref)
        if (!a) {
          const hash = ref.indexOf('#')
          byAccount.set(ref, { account_ref: ref, bank: hash >= 0 ? ref.slice(0, hash) : ref, acct: hash >= 0 ? ref.slice(hash + 1) : '', count: 1 })
        } else a.count++
      }
    }

    // Current attestation state — reset by any data mutation (QA finding) —
    // and the coverage answers (financials_meta, Slice 9). (`db` hoisted above.)
    // Was `.eq('status','completed')` — which MISSED every `reviewed` row, so
    // the page read back no attestation and no coverage answers for 47 of 79
    // account-years (2026-08-03). Now the one resolver, same row the write
    // routes use.
    const { resolveClientSubmission } = await import('@/lib/tax/resolve-submission')
    const sub = await resolveClientSubmission<{ confirmation_accepted: boolean | null; financials_meta: { coverage_answers?: unknown } | null }>(
      db, accountId, taxYear, 'confirmation_accepted, financials_meta',
    )

    // Is the client allowed to change anything right now? (2026-08-03.)
    // The page used to receive NO lock state at all, so it drew every control
    // as live and the client only discovered the refusal by tapping — and the
    // refusal then rendered in one strip at the top of a very long page, which
    // Bence Koncz (Imperium) never saw at all: from the question cards at the
    // bottom the button simply did nothing. Sending the state lets the UI say
    // so up front and disable the controls.
    //
    // Same resolver as the `sub` read above and as every write route, so the
    // banner, the payload and the actual 409 all describe ONE row.
    const { resolveEditability } = await import('@/lib/tax/resolve-submission')
    const { editable, reviewStatus: lockStatus } = await resolveEditability(supabaseAdmin, accountId, taxYear)

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
    const { getExpenseBuckets, OTHER_BUCKET_SLUG, OTHER_BUCKET_LABEL } = await import('@/lib/tax/expense-buckets')
    const buckets = await getExpenseBuckets(db)

    // Operating-expense breakdown by accountant bucket (Luca: "more detail in the
    // P&L"). Phase 2 fix: the breakdown now comes from the ENGINE draft
    // (view.draft.operating_expense_breakdown), computed on the SAME USD-converted,
    // refund-netted rows as the headline total — so the parts always sum to the
    // total (the old inline sum used raw native amounts and drifted by the FX
    // uplift + refunds for multi-currency accounts, e.g. Dynamiq's $23,245 gap).
    // Here we only map the engine's ai_bucket keys to live catalog labels; an
    // unknown/absent bucket folds into "other". The slug still travels with each
    // line for the drill-down (Luca, dev_task 1bee0ffe).
    const bucketLabelMap = new Map(buckets.map(b => [b.slug, b.label]))
    const validSlugs = new Set(buckets.map(b => b.slug))
    const labelledMap = new Map<string, number>()
    for (const { bucket, total } of view.draft.operating_expense_breakdown) {
      const slug = validSlugs.has(bucket) ? bucket : OTHER_BUCKET_SLUG
      labelledMap.set(slug, (labelledMap.get(slug) ?? 0) + total)
    }
    const expense_breakdown = Array.from(labelledMap.entries())
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
      editable,
      reviewStatus: lockStatus,
      files: Array.from(bySource.entries()).map(([source_file_id, s]) => ({ source_file_id, ...s })),
      accounts: Array.from(byAccount.values()).sort((a, b) => b.count - a.count),
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
