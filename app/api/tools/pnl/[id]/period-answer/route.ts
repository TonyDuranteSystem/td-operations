/**
 * POST /api/tools/pnl/[id]/period-answer — apply one location-period answer
 * ("Were you in Italy Feb–Aug?" → all business / all personal) as a REVERSIBLE
 * attested batch (STAFF ONLY, Phase 2b).
 *
 * Guard set (senior-engineer round-2 conditions — all five, in order):
 *  (i)   the client sends a PERIOD DESCRIPTOR + the counts the confirm modal
 *        displayed — never transaction ids; the eligible set is recomputed
 *        server-side fresh;
 *  (ii)  the UPDATE re-evaluates the full predicate itself (one atomic SQL
 *        statement — TOCTOU-safe by construction) with the NULL-safe manual
 *        guard `or(notes.is.null, notes.not.like.manual:%)` — a naive
 *        NOT LIKE silently drops NULL-notes rows (SQL three-valued logic);
 *  (iii) 409 when the recomputed count/total differs from what the modal
 *        showed (data moved under the user — re-render, re-confirm);
 *  (iv)  409 while the AI job is running or the workspace is stale — both
 *        RECOMPUTED here, never trusted from the client;
 *  (v)   the server generates the batch id; a duplicate submit finds an empty
 *        eligible set and 409s (swept rows are now manual:) — no orphan
 *        headers (guards run before any write).
 *
 * Write order (engineer cond. 2): guards → capture prior state → insert batch
 * header + rows → ONE atomic UPDATE returning ids → reconcile (drop captured
 * rows the UPDATE didn't touch, stamp ACTUAL counts) → void header on error.
 *
 * Period answers write ZERO learned rules and ZERO catalog entries — "Glovo =
 * business" was true for the Italy period only; merchant-level learning stays
 * exclusively on per-group answers.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import { fetchAllPaged } from '@/lib/bank-transactions-fetch'
import { PERIOD_SWEEPABLE_CATEGORIES } from '@/lib/tax/presence-periods'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const LOC_CODE_RE = /^[A-Z]{2}$/
/** NULL-safe "not hand-answered" guard — PostgREST or() syntax (\* = wildcard). */
const NOT_MANUAL_OR = 'notes.is.null,notes.not.like.manual:*'

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const workspaceId = params.id
  try {
    const body = await request.json().catch(() => ({})) as {
      loc_codes?: string[]; period_start?: string; period_end?: string
      choice?: string; expected_row_count?: number; expected_dollar_total?: number
      scope?: string
    }
    const locCodes = Array.isArray(body.loc_codes) ? body.loc_codes.filter(c => typeof c === 'string' && LOC_CODE_RE.test(c)) : []
    let { period_start, period_end } = body
    const { choice } = body
    // S3: scope 'country' = a COUNTRY-POLICY answer ("everything in Spain is
    // business") — full tax year, and the location filter includes AI-read
    // places (the period scope stays deterministic-only per F3). The stored
    // full-year answer row IS the policy record S4 replays.
    const scope: 'period' | 'country' = body.scope === 'country' ? 'country' : 'period'
    const LOC_SOURCES = scope === 'country' ? ['text', 'map', 'ai'] : ['text', 'map']
    if (locCodes.length === 0 || (choice !== 'business' && choice !== 'personal')
      || typeof body.expected_row_count !== 'number' || typeof body.expected_dollar_total !== 'number') {
      return NextResponse.json({ error: 'loc_codes, choice (business|personal), expected_row_count and expected_dollar_total are required.' }, { status: 400 })
    }
    if (scope === 'period' && (!period_start || !period_end)) {
      return NextResponse.json({ error: 'period_start and period_end are required.' }, { status: 400 })
    }

    // Guard (iv), REVISED 2026-07-04 (prod incident: Antonio's period taps
    // bounced for hours behind a running chain). The original blanket
    // 409-while-aiPending assumed period detection depended on AI-written
    // loc data — FALSE in shipped v1: loc_* labels are DETERMINISTIC-only
    // (stamped at Generate; the AI chain never writes them), so a running
    // chain cannot invalidate the detected periods. The REAL race — the AI
    // booking rows between the modal render and the confirm — is already
    // covered row-wise (sweep TOCTOU + manual-guard) and set-wise by guard
    // (iii): any drift in the confirmed count/total → 409 → re-confirm with
    // fresh numbers. Only the STALE guard (new statements after generation,
    // where detection genuinely ran on incomplete data) remains blocking.
    const { data: wsRow } = await db.from('pnl_workspaces').select('generated_at, tax_year').eq('id', workspaceId).maybeSingle()
    if (!wsRow) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
    // Country scope: the range is ALWAYS the whole tax year, derived
    // server-side — a full-year loc_codes answer row is unambiguously a
    // country policy, never a client-supplied window.
    if (scope === 'country') {
      const year = Number(wsRow.tax_year)
      if (!Number.isInteger(year)) return NextResponse.json({ error: 'Workspace has no tax year.' }, { status: 400 })
      period_start = `${year}-01-01`
      period_end = `${year}-12-31`
    }
    if (wsRow.generated_at) {
      const { data: newest } = await db
        .from('pnl_workspace_transactions')
        .select('created_at')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (newest?.created_at && String(newest.created_at) > String(wsRow.generated_at)) {
        return NextResponse.json({ error: 'New statements were added after the last generation — Regenerate the P&L first.' }, { status: 409 })
      }
    }

    // Guard (i): recompute the eligible set fresh. Same predicate as the UPDATE.
    const sweepable = [...PERIOD_SWEEPABLE_CATEGORIES]
    const candidates = await fetchAllPaged<{ id: string; amount: number | string; category: string; notes: string | null }>(async (from, to) => {
      const { data, error } = await db
        .from('pnl_workspace_transactions')
        .select('id, amount, category, notes')
        .eq('workspace_id', workspaceId)
        .gte('transaction_date', period_start)
        .lte('transaction_date', period_end)
        .in('loc_code', locCodes)
        // S2/S3: scope-dependent sources — 'period' is deterministic-only
        // (detection and sweep must agree, F3); 'country' includes AI-read
        // places (that's its purpose). SAME LOC_SOURCES in all four queries
        // INCLUDING the sweep, or the modal counts and the booked set diverge.
        .in('loc_source', LOC_SOURCES)
        .lt('amount', 0)
        .in('category', sweepable)
        .or(NOT_MANUAL_OR)
        .order('id', { ascending: true })
        .range(from, to)
      if (error) throw new Error(error.message)
      return (data ?? []) as Array<{ id: string; amount: number | string; category: string; notes: string | null }>
    })
    // Honest skip counts for the response (engineer cond. 7 / Slice 7c pattern).
    const { count: manualCount } = await db
      .from('pnl_workspace_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .gte('transaction_date', period_start)
      .lte('transaction_date', period_end)
      .in('loc_code', locCodes)
      .in('loc_source', LOC_SOURCES)
      .lt('amount', 0)
      .like('notes', 'manual:%')
    const { count: locatedCount } = await db
      .from('pnl_workspace_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .gte('transaction_date', period_start)
      .lte('transaction_date', period_end)
      .in('loc_code', locCodes)
      .in('loc_source', LOC_SOURCES)
      .lt('amount', 0)

    const total = candidates.reduce((s, r) => s + Math.abs(Number(r.amount)), 0)
    // Guard (iii): what the user confirmed must be what the sweep will do.
    if (candidates.length !== body.expected_row_count || Math.abs(total - body.expected_dollar_total) > 0.01) {
      return NextResponse.json({
        error: 'The transactions in this period changed since the screen loaded — review the updated numbers and confirm again.',
        fresh: { row_count: candidates.length, dollar_total: total },
      }, { status: 409 })
    }
    if (candidates.length === 0) {
      return NextResponse.json({ error: 'Nothing left to book in this period (it may already be answered).' }, { status: 409 })
    }

    const target = choice === 'business'
      ? { category: 'expense', subcategory: 'period_answer' }   // ai_bucket untouched — breakdown reads it
      : { category: 'distribution', subcategory: 'personal_draw' }

    // Capture prior state (undo restore source) — includes ai:high@vN notes.
    // CHUNKED (prod incident: a 957-row period's ids in one .in() blew the
    // URL length limit → 500 — the exact 2000-id precedent guard (i) cited).
    const prior: Array<{ id: string; category: string; subcategory: string | null; notes: string | null }> = []
    const candidateIds = candidates.map(c => c.id)
    for (let i = 0; i < candidateIds.length; i += 200) {
      const { data: preRows, error: preErr } = await db
        .from('pnl_workspace_transactions')
        .select('id, category, subcategory, notes')
        .eq('workspace_id', workspaceId)
        .in('id', candidateIds.slice(i, i + 200))
      if (preErr) throw new Error(preErr.message)
      prior.push(...((preRows ?? []) as typeof prior))
    }

    // Batch header + rows BEFORE the sweep (a swept row without restore data
    // must be impossible; the reverse — captured but unswept — reconciles away).
    const { data: header, error: headerErr } = await db
      .from('pnl_period_answers')
      .insert({
        workspace_id: workspaceId,
        loc_codes: locCodes,
        period_start,
        period_end,
        choice,
        actor_id: user?.email ?? 'staff',
        actor_role: 'staff', // v1 is staff-only; 'client' is reserved for the portal flip
        row_count: candidates.length,
        dollar_total: total,
      })
      .select('id')
      .single()
    if (headerErr || !header) throw new Error(`Could not create the period-answer record: ${headerErr?.message}`)
    const batchId = header.id as string

    try {
      for (let i = 0; i < prior.length; i += 500) {
        const chunk = prior.slice(i, i + 500).map(p => ({
          batch_id: batchId,
          transaction_id: p.id,
          prev_category: p.category,
          prev_subcategory: p.subcategory,
          prev_notes: p.notes,
        }))
        const { error } = await db.from('pnl_period_answer_rows').insert(chunk)
        if (error) throw new Error(`Could not capture prior state: ${error.message}`)
      }

      // Guard (ii): the sweep re-evaluates the whole predicate on the UPDATE.
      // PROD INCIDENT (2026-07-04): production's PostgREST rejects `or=` on
      // PATCH with a phantom "column does not exist" (42703) even though the
      // identical filter works on GET — sandbox runs a version without the
      // bug, which is why the harness was green while every real click 500'd.
      // Version-proof equivalent: TWO atomic UPDATEs whose simple filters
      // union to the exact NULL-safe predicate — (notes IS NULL) ∪ (notes NOT
      // LIKE 'manual:%', which on non-null rows is precisely the remainder).
      // Each statement keeps every TOCTOU guard; the capture+reconcile+notes
      // machinery already tolerates a kill between them.
      const sweepBase = () => db
        .from('pnl_workspace_transactions')
        .update({ ...target, notes: `manual: ${scope} answer ${batchId}` })
        .eq('workspace_id', workspaceId)
        .gte('transaction_date', period_start)
        .lte('transaction_date', period_end)
        .in('loc_code', locCodes)
        // Same sources as the candidate count — the confirmed set IS the swept
        // set (fixes the F3 gap where the sweep lacked this filter entirely).
        .in('loc_source', LOC_SOURCES)
        .lt('amount', 0)
        .in('category', sweepable)
      const { data: sweptNull, error: err1 } = await sweepBase().is('notes', null).select('id, amount')
      if (err1) throw new Error(err1.message)
      const { data: sweptRest, error: err2 } = await sweepBase().not('notes', 'like', 'manual:%').select('id, amount')
      if (err2) throw new Error(err2.message)
      const swept = ([...(sweptNull ?? []), ...(sweptRest ?? [])]) as Array<{ id: string; amount: number | string }>
      const sweptIds = new Set(swept.map(r => r.id))

      // Reconcile: drop captured-but-unswept rows (answered mid-flight), stamp
      // the ACTUAL counts on the header.
      const unswept = prior.filter(p => !sweptIds.has(p.id)).map(p => p.id)
      for (let i = 0; i < unswept.length; i += 500) {
        await db.from('pnl_period_answer_rows').delete().eq('batch_id', batchId).in('transaction_id', unswept.slice(i, i + 500))
      }
      const sweptTotal = swept.reduce((s, r) => s + Math.abs(Number(r.amount)), 0)
      await db.from('pnl_period_answers').update({ row_count: swept.length, dollar_total: sweptTotal }).eq('id', batchId)

      // Override telemetry — the largest human-override signal the system
      // collects; same pattern as the single-group answer route.
      const changedOverrides = prior.filter(p =>
        sweptIds.has(p.id) && (p.notes ?? '').startsWith('ai:high') && p.category !== target.category)
      if (changedOverrides.length > 0) {
        try {
          await db.from('action_log').insert({
            actor: user?.email ?? 'staff',
            action_type: 'ai_categorization_override',
            table_name: 'pnl_workspace_transactions',
            record_id: workspaceId,
            summary: `Period answer (${choice}) changed ${changedOverrides.length} AI-booked row(s) → ${target.category}`,
            details: { workspace_id: workspaceId, batch_id: batchId, count: changedOverrides.length, from_categories: changedOverrides.map(o => o.category), to_category: target.category, ai_versions: Array.from(new Set(changedOverrides.map(o => o.notes))) },
          })
        } catch (e) {
          console.error('[tools/pnl] period override telemetry failed (sweep saved fine):', e)
        }
      }

      return NextResponse.json({
        ok: true,
        batch_id: batchId,
        swept: swept.length,
        skipped_manual: manualCount ?? 0,
        skipped_ineligible: Math.max(0, (locatedCount ?? 0) - (manualCount ?? 0) - candidates.length),
      })
    } catch (err) {
      // Void the batch so a failed sweep never leaves a half-batch behind.
      await db.from('pnl_period_answer_rows').delete().eq('batch_id', batchId)
      await db.from('pnl_period_answers').delete().eq('id', batchId)
      throw err
    }
  } catch (err) {
    console.error('[tools/pnl] period-answer failed:', err)
    return NextResponse.json({ error: 'Could not book the period — please try again.' }, { status: 500 })
  }
}
