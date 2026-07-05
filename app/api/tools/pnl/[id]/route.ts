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
        .select('id, description, counterparty, amount, currency, transaction_date, bank_name, ai_lean, ai_bucket, category, subcategory')
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
    })))

    // Per-file source cards.
    const sources = await fetchAllPaged<Record<string, unknown>>(async (from, to) => {
      const { data, error } = await db
        .from('pnl_workspace_transactions')
        .select('source_file_id, bank_name, account_type, transaction_date')
        .eq('workspace_id', workspaceId)
        .order('id', { ascending: true })
        .range(from, to)
      if (error) throw new Error(error.message)
      return (data ?? []) as Record<string, unknown>[]
    })
    const bySource = new Map<string, { bank_name: string; count: number; from: string; to: string }>()
    for (const r of sources) {
      const key = (r.source_file_id as string) ?? 'unknown'
      const cur = bySource.get(key)
      const date = String(r.transaction_date ?? '')
      if (!cur) bySource.set(key, { bank_name: String(r.bank_name ?? ''), count: 1, from: date, to: date })
      else { cur.count++; if (date < cur.from) cur.from = date; if (date > cur.to) cur.to = date }
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

    // In-flight / failed workspace ingest jobs (by distinct file path).
    const { data: ingestJobs } = await supabaseAdmin
      .from('job_queue')
      .select('status, result, payload')
      .eq('job_type', 'ingest_workspace_statement')
      .eq('related_entity_id', workspaceId)
      .in('status', ['pending', 'processing', 'failed', 'completed'])
    const byPath = new Map<string, { succeeded: boolean; pending: boolean; failed: boolean }>()
    for (const j of (ingestJobs ?? []) as Array<{ status: string; result: { ok?: boolean } | null; payload: { path?: string } | null }>) {
      const path = j.payload?.path
      if (!path) continue
      const e = byPath.get(path) ?? { succeeded: false, pending: false, failed: false }
      if (j.status === 'completed' && j.result?.ok !== false) e.succeeded = true
      else if (j.status === 'pending' || j.status === 'processing') e.pending = true
      else if (j.status === 'failed' || (j.status === 'completed' && j.result?.ok === false)) e.failed = true
      byPath.set(path, e)
    }
    let ingestPending = 0, ingestFailed = 0
    for (const e of Array.from(byPath.values())) {
      if (e.succeeded) continue
      if (e.pending) ingestPending++
      else if (e.failed) ingestFailed++
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
    }

    // Generate stage (Antonio, 2026-07-02): NULL generated_at = upload mode —
    // the UI shows the statement manager and a "Generate P&L" button, no
    // totals. `stale` = statements were ingested AFTER the last generation, so
    // the rendered totals no longer match the data → the UI asks to Regenerate.
    const { data: wsRow } = await db
      .from('pnl_workspaces')
      .select('generated_at, linked_account_id')
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

    // Location-period triage (Phase 2b, staff-only tool — the portal API never
    // sends these). Residence anchor = the linked client's declared fiscal-
    // residence country from the CRM; periods there are home life, never cards.
    const { detectPresencePeriods } = await import('@/lib/tax/presence-periods')
    const { residenceCountryToIso } = await import('@/lib/tax/merchant-locations')
    let residenceCountry: string | null = null
    let residenceOnFile = false
    if (wsRow?.linked_account_id) {
      const { data: acRows } = await db
        .from('account_contacts')
        .select('contact_id')
        .eq('account_id', wsRow.linked_account_id)
      const contactIds = ((acRows ?? []) as Array<{ contact_id: string }>).map(r => r.contact_id)
      if (contactIds.length > 0) {
        const { data: contactRows } = await db
          .from('contacts')
          .select('address_country')
          .in('id', contactIds)
        for (const c of (contactRows ?? []) as Array<{ address_country: string | null }>) {
          const iso = residenceCountryToIso(c.address_country)
          if (iso) { residenceCountry = iso; residenceOnFile = true; break }
        }
      }
    }
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
      .select('id, loc_codes, period_start, period_end, choice, actor_role, row_count, dollar_total, created_at, undone_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
    const periodAnswers = ((batchRows ?? []) as Array<Record<string, unknown>>).filter(b => !b.undone_at)
    // S2/F3: period DETECTION stays deterministic-only (AI-read places never
    // create presence density); the FULL located set (incl. loc_source='ai')
    // feeds the S3 country cards below.
    const allPeriods = detectPresencePeriods(
      locatedRows
        .filter(r => (r.loc_source as string | null) === 'text' || (r.loc_source as string | null) === 'map')
        .map(r => ({
          id: String(r.id),
          transaction_date: String(r.transaction_date ?? ''),
          description: (r.description as string | null) ?? null,
          counterparty: (r.counterparty as string | null) ?? null,
          amount: Number(r.amount),
          category: (r.category as string | null) ?? null,
          notes: (r.notes as string | null) ?? null,
          loc_code: (r.loc_code as string | null) ?? null,
        })),
      residenceCountry,
    )
    // A period already covered by an active (not-undone) batch is answered —
    // no card; the attestation line renders from period_answers instead. A
    // period with nothing sweepable left renders no card either.
    const overlapDays = (aStart: string, aEnd: string, bStart: string, bEnd: string) => {
      const s = Math.max(Date.parse(aStart), Date.parse(bStart))
      const e = Math.min(Date.parse(aEnd), Date.parse(bEnd))
      return e < s ? 0 : (e - s) / 86400000 + 1
    }
    const periods = allPeriods.filter(p => {
      if (p.sweepable_count === 0) return false
      const pDays = overlapDays(p.start, p.end, p.start, p.end)
      return !periodAnswers.some(b =>
        (b.loc_codes as string[]).includes(p.primary) &&
        overlapDays(p.start, p.end, String(b.period_start), String(b.period_end)) / pDays >= 0.8)
    })

    // S3 — country-policy cards: one card per non-residence country with
    // still-sweepable located spend (ANY source incl. 'ai'). Counts mirror the
    // country-scope sweep predicate EXACTLY (amount<0, sweepable category,
    // not hand-answered) — they feed the confirm modal's expected_* guard.
    // A country covered by an ACTIVE full-year answer (the stored policy)
    // shows no card.
    const { PERIOD_SWEEPABLE_CATEGORIES } = await import('@/lib/tax/presence-periods')
    const { rowRootKey } = await import('@/lib/tax/row-root')
    const wsYear = Number((await db.from('pnl_workspaces').select('tax_year').eq('id', workspaceId).maybeSingle()).data?.tax_year)
    const yearStart = `${wsYear}-01-01`, yearEnd = `${wsYear}-12-31`
    const sweepableSet = new Set<string>(PERIOD_SWEEPABLE_CATEGORIES as readonly string[])
    const coveredCountries = new Set<string>()
    for (const b of periodAnswers) {
      if (String(b.period_start) <= yearStart && String(b.period_end) >= yearEnd) {
        for (const c of (b.loc_codes as string[])) coveredCountries.add(c)
      }
    }
    const byCountry = new Map<string, { count: number; total: number; merchants: Map<string, number>; keys: Set<string> }>()
    for (const r of locatedRows) {
      const code = (r.loc_code as string | null) ?? ''
      if (!code || code === residenceCountry || coveredCountries.has(code)) continue
      const amt = Number(r.amount)
      const notes = (r.notes as string | null) ?? null
      if (amt >= 0 || !sweepableSet.has(String(r.category)) || (notes !== null && notes.startsWith('manual:'))) continue
      const e = byCountry.get(code) ?? { count: 0, total: 0, merchants: new Map(), keys: new Set() }
      e.count++
      e.total += Math.abs(amt)
      const root = rowRootKey((r.description as string | null) ?? '', (r.counterparty as string | null) ?? null)
      e.merchants.set(root.label, (e.merchants.get(root.label) ?? 0) + 1)
      e.keys.add(root.key)
      byCountry.set(code, e)
    }
    const country_cards = Array.from(byCountry.entries())
      .map(([loc_code, e]) => ({
        loc_code,
        count: e.count,
        total: Math.round(e.total * 100) / 100,
        merchants: Array.from(e.merchants.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([m]) => m),
        keys: Array.from(e.keys),
      }))
      .sort((a, b) => b.count - a.count)

    return NextResponse.json({
      ...view,
      questions,
      periods,
      country_cards,
      period_answers: periodAnswers,
      residence_country: residenceCountry,
      residence_on_file: residenceOnFile,
      // Coverage is a client-completeness nudge — not used in the staff scratch tool.
      coverage: { questions: [], unanswered: 0, incomplete: 0 },
      expense_breakdown,
      buckets,
      ingestPending,
      ingestFailed,
      attested: false, // workspaces have no attestation
      files: Array.from(bySource.entries()).map(([source_file_id, s]) => ({ source_file_id, ...s })),
      generated_at: generatedAt,
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
