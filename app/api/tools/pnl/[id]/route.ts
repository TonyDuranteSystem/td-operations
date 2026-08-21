/**
 * Standalone P&L tool — single workspace routes (STAFF ONLY).
 *
 * GET    /api/tools/pnl/[id]  — the full review view (same shape the portal
 *                              review screen consumes), computed from the
 *                              ISOLATED workspace tables.
 * DELETE /api/tools/pnl/[id]  — delete the workspace and PURGE its data:
 *                              members + transactions cascade via FK; uploaded
 *                              files under pnl-workspaces/{id}/ are removed
 *                              (forked client PII never lingers in scratch).
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { fetchAllPaged } from '@/lib/bank-transactions-fetch'
import { canonicalBankName } from '@/lib/tax/bank-identity'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const workspaceId = params.id
  try {
    const { getWorkspaceFinancialsView } = await import('@/lib/tax/workspace-orchestration')
    const view = await getWorkspaceFinancialsView(workspaceId)

    // Reviewable rows → pattern-grouped questions + expense breakdown (mirrors
    // the portal GET, against the workspace table).
    const { groupUncategorized } = await import('@/lib/tax/question-groups')
    const reviewable = await fetchAllPaged<Record<string, unknown>>(async (from, to) => {
      const { data, error } = await db
        .from('pnl_workspace_transactions')
        .select('id, description, counterparty, amount, currency, transaction_date, bank_name, ai_lean, ai_bucket, category, subcategory, notes')
        .eq('workspace_id', workspaceId)
        // 'refund' included since 2026-07-05 — AI-booked refunds were invisible
        // in the review (no-vanish violation): the client could never see or
        // correct them. 'conversion' stays excluded on purpose (auto-detected
        // internal transfers are not merchant decisions).
        .in('category', ['uncategorized', 'expense', 'fee', 'cogs', 'income', 'distribution', 'contribution', 'refund'])
        .order('id', { ascending: true })
        .range(from, to)
      if (error) throw new Error(error.message)
      return (data ?? []) as Record<string, unknown>[]
    })
    const questions = groupUncategorized(reviewable.map(r => ({
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
    })))

    // Per-file source cards.
    const sources = await fetchAllPaged<Record<string, unknown>>(async (from, to) => {
      const { data, error } = await db
        .from('pnl_workspace_transactions')
        .select('source_file_id, bank_name, account_type, account_ref, transaction_date')
        .eq('workspace_id', workspaceId)
        .order('id', { ascending: true })
        .range(from, to)
      if (error) throw new Error(error.message)
      return (data ?? []) as Record<string, unknown>[]
    })
    const bySource = new Map<string, { bank_name: string; count: number; from: string; to: string }>()
    const byAccount = new Map<string, { account_ref: string; bank: string; acct: string; count: number }>()
    for (const r of sources) {
      const key = (r.source_file_id as string) ?? 'unknown'
      const cur = bySource.get(key)
      const date = String(r.transaction_date ?? '')
      if (!cur) bySource.set(key, { bank_name: canonicalBankName(String(r.bank_name ?? '')), count: 1, from: date, to: date })
      else { cur.count++; if (date < cur.from) cur.from = date; if (date > cur.to) cur.to = date }
      const ref = (r.account_ref as string | null) ?? null
      if (ref) {
        const a = byAccount.get(ref)
        if (!a) {
          const hash = ref.indexOf('#')
          byAccount.set(ref, { account_ref: ref, bank: hash >= 0 ? ref.slice(0, hash) : ref, acct: hash >= 0 ? ref.slice(hash + 1) : '', count: 1 })
        } else a.count++
      }
    }

    // Expense breakdown by bucket (same policy as the portal route).
    const { getExpenseBuckets, isOperatingExpenseRow, bucketSlugForRow, OTHER_BUCKET_LABEL } = await import('@/lib/tax/expense-buckets')
    const buckets = await getExpenseBuckets(db)
    const bucketLabelMap = new Map(buckets.map(b => [b.slug, b.label]))
    const validSlugs = new Set(buckets.map(b => b.slug))
    const breakdownMap = new Map<string, number>()
    for (const r of reviewable) {
      const amt = Number(r.amount)
      if (!isOperatingExpenseRow(r.category as string | null, amt)) continue
      const slug = bucketSlugForRow(r.ai_bucket, validSlugs)
      breakdownMap.set(slug, (breakdownMap.get(slug) ?? 0) + Math.abs(amt))
    }
    const expense_breakdown = Array.from(breakdownMap.entries())
      .map(([slug, total]) => ({ slug, label: bucketLabelMap.get(slug) ?? OTHER_BUCKET_LABEL, total }))
      .sort((a, b) => b.total - a.total)

    // In-flight / failed workspace ingest jobs (by distinct file path). Same
    // shared per-file classifier the client portal uses (lib/tax/ingest-file-
    // status.ts) — this route used to hand-roll its own copy with no
    // 'quarantined' branch, so a file merely awaiting a routine one-tap
    // format confirm was miscounted as genuinely failed here while the
    // client route correctly treated the identical state as still-pending
    // (2026-08-20 hard-stop plan review, senior-engineer + bug-hunter both
    // caught the disagreement independently). One implementation now, so the
    // two screens can never disagree about what "failed" means again.
    const { data: ingestJobs } = await supabaseAdmin
      .from('job_queue')
      .select('status, result, payload, created_at')
      .eq('job_type', 'ingest_workspace_statement')
      .eq('related_entity_id', workspaceId)
      .in('status', ['pending', 'processing', 'failed', 'completed'])
    const { computeIngestFileStates, summarizeIngestFileStates } = await import('@/lib/tax/ingest-file-status')
    const ingestJobRows = (ingestJobs ?? []) as Array<{ status: string; result: { ok?: boolean; steps?: Array<{ detail?: string }> } | null; payload: { tax_year?: number | string; path?: string } | null }>
    // taxYear here is a formality: workspace job payloads never carry
    // tax_year (a workspace has exactly one, via related_entity_id scoping
    // above), so computeIngestFileStates's tax_year check is a documented
    // no-op for this call regardless of the value passed.
    const fileStates = computeIngestFileStates(ingestJobRows, 0)
    const stateCounts = summarizeIngestFileStates(fileStates)
    const ingestPending = stateCounts.pending + stateCounts.quarantined
    const ingestFailed = stateCounts.failed

    // S1 (2026-07-07): files QUARANTINED for a one-tap format confirmation —
    // extracted from the failed jobs' marker steps, deduped by mapping id,
    // dropped once the path eventually ingested (succeeded) or was re-queued.
    const format_proposals: Array<{ mapping_id: string; file: string; path: string; bank_label: string; ambiguities: string[]; sample: unknown }> = []
    const seenMapping = new Set<string>()
    const jobsNewestFirst = ([...(ingestJobs ?? [])] as Array<{ status: string; result: { steps?: Array<{ detail?: string }> } | null; payload: { path?: string } | null; created_at?: string }>)
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
    for (const j of jobsNewestFirst) {
      if (j.status !== 'failed') continue
      const path = j.payload?.path
      if (!path || fileStates.get(path) === 'succeeded' || fileStates.get(path) === 'pending') continue
      for (const s of j.result?.steps ?? []) {
        const d = s.detail ?? ''
        const idx = d.indexOf('FORMAT_CONFIRMATION_NEEDED:')
        if (idx === -1) continue
        try {
          const q = JSON.parse(d.slice(idx + 'FORMAT_CONFIRMATION_NEEDED:'.length)) as { mapping_id?: string; file?: string; path?: string; bank_label?: string; ambiguities?: string[]; sample?: unknown }
          if (q.mapping_id && !seenMapping.has(q.mapping_id)) {
            seenMapping.add(q.mapping_id)
            format_proposals.push({ mapping_id: q.mapping_id, file: q.file ?? path.split('/').pop() ?? 'statement', path: q.path ?? path, bank_label: q.bank_label ?? 'Bank', ambiguities: q.ambiguities ?? [], sample: q.sample ?? null })
          }
        } catch { /* malformed marker — ignore */ }
      }
    }

    // Smart-categorization job still running? The UI keeps polling and shows
    // "AI is categorizing…" instead of a final-looking question list.
    const { count: aiPendingCount } = await supabaseAdmin
      .from('job_queue')
      .select('id', { count: 'exact', head: true })
      .eq('job_type', 'recategorize_workspace_ai')
      .eq('related_entity_id', workspaceId)
      .in('status', ['pending', 'processing'])

    // Self-healing chain state (Phase 3R): aiState/nextRetryAt come from the
    // SAME pure brain the watchdog acts on — the UI shows "continues
    // automatically" during backoff waits and a staff-attention line only
    // after the ladder is spent (staff never clicks anything). aiPending
    // keeps its exact meaning (the period-answer 409 gate reads it).
    let aiState: string = 'idle'
    let aiNextRetryAt: number | null = null
    let aiRemaining = 0
    try {
      const { chainStateForScope } = await import('@/lib/jobs/chain-watchdog')
      const chain = await chainStateForScope({ jobType: 'recategorize_workspace_ai', workspaceId })
      aiState = chain.state
      aiNextRetryAt = chain.nextRetryAt
      aiRemaining = chain.remaining
    } catch (e) {
      console.error('[tools/pnl] chain state failed (view unaffected):', e)
      // FAIL CLOSED (2026-08-19): the pre-try default (idle) reads as "all
      // clear" — a read failure must not look identical to "nothing is
      // running". aiPending (computed separately above) already reflects the
      // real live-job count regardless of this failure; this just keeps the
      // state label honest about the fact that state itself is unknown.
      aiState = 'running'
    }

    // Generate stage (Antonio, 2026-07-02): NULL generated_at = upload mode —
    // the UI shows the statement manager and a "Generate P&L" button, no
    // totals. `stale` = statements were ingested AFTER the last generation, so
    // the rendered totals no longer match the data → the UI asks to Regenerate.
    const { data: wsRow } = await db
      .from('pnl_workspaces')
      .select('generated_at, linked_account_id, prior_return_snapshot, updated_at, tax_year, coverage_answers')
      .eq('id', workspaceId)
      .maybeSingle()
    const generatedAt = (wsRow?.generated_at as string | null) ?? null
    let stale = false
    if (generatedAt) {
      const { data: newest } = await db
        .from('pnl_workspace_transactions')
        .select('created_at')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      stale = !!newest?.created_at && String(newest.created_at) > generatedAt
    }

    // Coverage questions (§3.4) — the workspace twin of the client portal's
    // check, wired up for the first time (2026-08-20 hard-stop plan; this
    // route used to hardcode an empty result, so a genuinely partial-year
    // workspace looked exactly like a complete one). Same pure function,
    // same `sources` shape already fetched above for the file cards —
    // answers live on this workspace's own coverage_answers column, the
    // twin of tax_return_submissions.financials_meta.coverage_answers.
    const { coverageQuestions, unansweredCoverage, incompleteCoverage, hasStructuralProblem } = await import('@/lib/tax/coverage')
    const wsTaxYear = wsRow?.tax_year != null ? Number(wsRow.tax_year) : new Date().getFullYear()
    const coverageAnswers = (wsRow?.coverage_answers ?? {}) as import('@/lib/tax/coverage').CoverageAnswers
    const covQs = coverageQuestions(sources.map(r => ({ bank_name: String(r.bank_name ?? ''), account_type: (r.account_type as string | null) ?? null, transaction_date: String(r.transaction_date ?? '') })), wsTaxYear)
    const coverage = {
      questions: covQs.map(q => ({ ...q, answer: coverageAnswers[q.key]?.answer ?? null })),
      unanswered: unansweredCoverage(covQs, coverageAnswers).length,
      incomplete: incompleteCoverage(covQs, coverageAnswers).length,
    }
    // Workspaces have no CRM override mechanism (that's a real-account/
    // submission concept) — Antonio's ruling is no staff bypass anyway, so
    // this is always false here, never a hidden escape hatch.
    const structuralProblem = hasStructuralProblem({
      ingestFailed,
      failedFilesOverridden: false,
      unansweredCoverage: coverage.unanswered,
      incompleteCoverage: coverage.incomplete,
    })

    // Location-period triage (Phase 2b; since Phase B2 the portal serves the
    // same cards from the client's books). Residence anchor = the linked
    // client's declared fiscal-residence country from the CRM; periods there
    // are home life, never cards.
    // Members-first resolution, same shared function the automatic sweep
    // uses (lib/tax/country-policy-sweep.ts::resolveAccountResidenceIso) —
    // this route used to hand-roll its own copy (any linked contact, first
    // resolvable, no member/role filter), which could disagree with the
    // sweep about the same account's residence country.
    const { resolveAccountResidenceIso } = await import('@/lib/tax/country-policy-sweep')
    // wsRow.tax_year != null guard: Number(null) is 0, an integer that would
    // wastefully (though harmlessly) send resolveAccountResidenceIso down the
    // wizard path querying tax_return_submissions for a year that can't exist.
    const residenceCountry = wsRow?.linked_account_id
      ? await resolveAccountResidenceIso(wsRow.linked_account_id, wsRow.tax_year != null ? Number(wsRow.tax_year) : null)
      : null
    const residenceOnFile = residenceCountry !== null
    const locatedRows = await fetchAllPaged<Record<string, unknown>>(async (from, to) => {
      const { data, error } = await db
        .from('pnl_workspace_transactions')
        .select('id, transaction_date, description, counterparty, amount, category, notes, loc_code, loc_source')
        .eq('workspace_id', workspaceId)
        .not('loc_code', 'is', null)
        .order('id', { ascending: true })
        .range(from, to)
      if (error) throw new Error(error.message)
      return (data ?? []) as Record<string, unknown>[]
    })
    const { data: batchRows } = await db
      .from('pnl_period_answers')
      .select('id, loc_codes, period_start, period_end, choice, actor_role, row_count, dollar_total, created_at, undone_at, policy_revoked_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
    const periodAnswers = ((batchRows ?? []) as Array<Record<string, unknown>>).filter(b => !b.undone_at)
    // Builder extracted to lib/tax/location-cards.ts (Phase B2, 2026-07-08) so
    // the portal GET serves the same cards from the client's books — semantics
    // unchanged (S2/F3 deterministic-only detection, S3 sweep-predicate counts,
    // S4 policy/revoke coverage). This caller still loads workspace rows +
    // workspace answers + the linked account's standing policies.
    const wsYear = Number((await db.from('pnl_workspaces').select('tax_year').eq('id', workspaceId).maybeSingle()).data?.tax_year)
    const accountPolicyCodes: string[] = []
    if (wsRow?.linked_account_id) {
      const { data: acctPolicies } = await db
        .from('account_location_policies')
        .select('loc_code')
        .eq('account_id', wsRow.linked_account_id)
        .eq('active', true)
      for (const p of (acctPolicies ?? []) as Array<{ loc_code: string }>) accountPolicyCodes.push(p.loc_code)
    }
    const { buildLocationCards } = await import('@/lib/tax/location-cards')
    const { periods, country_cards } = buildLocationCards({
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
      periodAnswers: periodAnswers.map(b => ({
        loc_codes: b.loc_codes as string[],
        period_start: String(b.period_start),
        period_end: String(b.period_end),
        policy_revoked_at: (b.policy_revoked_at as string | null) ?? null,
      })),
      accountPolicyCodes,
      residenceCountry,
      taxYear: wsYear,
    })

    return NextResponse.json({
      ...view,
      questions,
      periods,
      country_cards,
      period_answers: periodAnswers,
      residence_country: residenceCountry,
      residence_on_file: residenceOnFile,
      coverage,
      hasStructuralProblem: structuralProblem,
      expense_breakdown,
      buckets,
      ingestPending,
      ingestFailed,
      format_proposals,
      attested: false, // workspaces have no attestation
      files: Array.from(bySource.entries()).map(([source_file_id, s]) => ({ source_file_id, ...s })),
      accounts: Array.from(byAccount.values()).sort((a, b) => b.count - a.count),
      generated_at: generatedAt,
      // Staff prior-return control (2026-07-06): case+status — the UI decides
      // whether to show the set/clear buttons (never over a validated
      // extraction; the endpoint enforces the same server-side). beginning_cta
      // added (round-4 bug-hunter blocker) so the correction form can pre-fill
      // the REAL current figure instead of silently zeroing it on any edit.
      // expected_updated_at (round-4 minor) lets the 'corrected' choice on
      // this workspace's prior-return route apply the same optimistic-
      // concurrency guard the account-side routes already have.
      prior_return: wsRow?.prior_return_snapshot
        ? {
            case: (wsRow.prior_return_snapshot as { case?: string }).case ?? null,
            status: (wsRow.prior_return_snapshot as { status?: string }).status ?? null,
            beginning_cta: (await import('@/lib/tax/prior-return-case')).priorBeginningCta(wsRow.prior_return_snapshot as never),
          }
        : null,
      prior_return_updated_at: wsRow?.updated_at ?? null,
      stale,
      aiPending: aiPendingCount ?? 0,
      aiState,
      aiNextRetryAt,
      aiRemaining,
    })
  } catch (err) {
    console.error('[tools/pnl] view failed:', err)
    return NextResponse.json({ error: err instanceof Error && err.message === 'Workspace not found' ? 'Workspace not found' : 'Could not load the workspace — please try again.' }, { status: 500 })
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const workspaceId = params.id
  try {
    // Purge uploaded files first (best-effort — never blocks the row delete).
    try {
      const prefix = `pnl-workspaces/${workspaceId}`
      const { data: files } = await supabaseAdmin.storage.from('onboarding-uploads').list(prefix)
      if (files && files.length > 0) {
        await supabaseAdmin.storage.from('onboarding-uploads').remove(files.map(f => `${prefix}/${f.name}`))
      }
    } catch (e) {
      console.error('[tools/pnl] storage purge failed (continuing):', e)
    }
    // Delete the workspace — members + transactions cascade via FK.
    const { error } = await db.from('pnl_workspaces').delete().eq('id', workspaceId)
    if (error) throw new Error(error.message)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[tools/pnl] delete failed:', err)
    return NextResponse.json({ error: 'Could not delete the workspace.' }, { status: 500 })
  }
}
