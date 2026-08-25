/**
 * POST /api/tools/pnl/[id]/answer — categorize a group of workspace transactions
 * (STAFF ONLY). Mirrors the portal answer route against the ISOLATED workspace
 * table.
 *
 * AUTO-LEARN (Phase 4, 2026-07-02 — deliberate change to the old "sealed leak
 * #2" stance): a staff answer now ALSO persists a learned rule, so the same
 * merchant auto-categorizes on every future run, year after year:
 *   - forked workspace (linked client) → ACCOUNT-scoped rule (the client's
 *     permanent memory — staff answering is as authoritative as the client);
 *   - blank workspace → WORKSPACE-scoped rule (dies with the workspace,
 *     PROMOTED to the client on Save-to-client).
 * Global rules are still never written from here — no blank-scratch answer can
 * ever affect another client (DB CHECK + loader filters enforce it).
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  try {
    const body = await request.json().catch(() => ({})) as { answer?: string; transaction_ids?: string[]; bulk?: boolean; group_labels?: string[]; suspected?: boolean; member?: string }
    /**
     * THE OWNER QUESTION — same contract as the client portal route.
     *
     * This surface renders the identical card, so it can post the identical
     * answer. Without these two fields it silently dropped both halves:
     *  - no `| Member:` tail, so the confirmed owner was unknown and the draw
     *    was spread across every partner by ownership % — straight into the
     *    accountant's own workbook;
     *  - and it LEARNED a merchant rule, account-scoped for a forked workspace,
     *    which then re-booked every sibling payment on the real client's next
     *    re-sort and suppressed the question for ever.
     */
    const isSuspectedAnswer = body.suspected === true
    const suspectedMember = typeof body.member === 'string' ? body.member.trim().slice(0, 120) : ''
    const ids = Array.isArray(body.transaction_ids) ? body.transaction_ids.filter(Boolean) : []
    if (!body.answer || ids.length === 0) {
      return NextResponse.json({ error: 'answer and transaction_ids are required.' }, { status: 400 })
    }
    // Bulk mode (multi-group one-tap, 2026-07-05): books rows but NEVER writes
    // learned rules — one lazy sweep of 30 merchants must not silently
    // auto-categorize those merchants forever (period-sweep precedent + the
    // removed "All as:" incident). The distinct notes tag makes bulk-booked
    // rows queryable and is the undo route's guard.
    const isBulk = body.bulk === true

    const { categoryForAnswer } = await import('@/lib/tax/question-groups')
    const mapped = categoryForAnswer(body.answer)
    if (!mapped) return NextResponse.json({ error: `Unknown answer: ${body.answer}` }, { status: 400 })

    // Hard-stop parity (2026-08-21, live-QA bug-hunter blocker): this route
    // had NO structural-problem check — reachable both from the (correctly
    // gated) main categorization queue AND from the "Time away from home
    // base" inline review card, which was NOT gated. Worse here than the
    // portal twin: a forked workspace's answer can auto-learn a PERMANENT,
    // account-scoped rule onto the real linked client below — never let that
    // happen from a workspace whose own data is known-unreliable.
    const { getWorkspaceStructuralProblem } = await import('@/lib/tax/workspace-orchestration')
    if (await getWorkspaceStructuralProblem(params.id)) {
      return NextResponse.json({ error: 'This workspace has an unresolved data problem (an unreadable statement, or a missing-months question) — fix that first before answering anything else.' }, { status: 422 })
    }

    // Override telemetry (Phase 0.5): rows the AI auto-booked (notes ai:high@vN)
    // that a human is about to re-answer are the PRODUCTION precision meter —
    // captured BEFORE the update overwrites the notes. Chunked ×200: a single
    // .in() with ~950+ ids overflows the PostgREST URL and 500s (prod
    // incident 2026-07-04 — the period-answer route hit the same wall).
    const aiOverrides: Array<{ id: string; category: string; notes: string }> = []
    for (let i = 0; i < ids.length; i += 200) {
      const { data: preRows, error: preErr } = await db
        .from('pnl_workspace_transactions')
        .select('id, category, notes')
        .eq('workspace_id', params.id)
        .in('id', ids.slice(i, i + 200))
        .like('notes', 'ai:high%')
      if (preErr) console.error('[tools/pnl] telemetry pre-select failed (answer continues):', preErr.message)
      aiOverrides.push(...((preRows ?? []) as Array<{ id: string; category: string; notes: string }>))
    }

    // DEFENSE IN DEPTH — a plain (non-owner-flagged) staff answer must never
    // touch a row already confirmed to a specific member, even on a stale tab
    // or a future regression. Mirrors the identical fix on the portal's own
    // answer route (app/api/portal/tax-financials/answer/route.ts) tonight —
    // this staff surface shares the same underlying risk: the client-side
    // exclusion in the shared review component is not a server-side guarantee
    // on its own. Bulk needs no separate check — its own update below is
    // already restricted to FROM-category 'uncategorized' only, which a
    // confirmed distribution/contribution row can never be.
    let plainAnswerIds = ids
    if (!isBulk && !isSuspectedAnswer) {
      const { confirmedMemberFromNote } = await import('@/lib/tax/member-names')
      const protectedIds = new Set<string>()
      for (let i = 0; i < ids.length; i += 200) {
        const { data } = await db
          .from('pnl_workspace_transactions')
          .select('id, notes')
          .eq('workspace_id', params.id)
          .in('id', ids.slice(i, i + 200))
        for (const r of ((data ?? []) as Array<{ id: string; notes: string | null }>)) {
          if (confirmedMemberFromNote(r.notes)) protectedIds.add(r.id)
        }
      }
      if (protectedIds.size > 0) {
        plainAnswerIds = ids.filter(id => !protectedIds.has(id))
      }
    }

    // Only re-file rows still in a reviewable state (never override a prior
    // manual decision by re-answering a stale group), scoped to this workspace.
    // 'refund' is re-answerable (a mis-booked refund must be correctable);
    // 'conversion' stays protected. Chunked ×200 like the capture above.
    // Partial-failure contract: accumulate successes; post-steps (telemetry,
    // learning) still run for whatever DID change before we report the error —
    // otherwise changed rows would be missing their bookkeeping side-effects.
    const updatedRows: Array<{ id: string; description: string | null; counterparty: string | null; amount: number | string }> = []
    let updateError: string | null = null
    for (let i = 0; i < plainAnswerIds.length; i += 200) {
      const { data, error } = await db
        .from('pnl_workspace_transactions')
        .update({ category: mapped.category, subcategory: mapped.subcategory, notes: (() => {
          const base = isBulk ? `manual: bulk staff answer (${body.answer})` : `manual: staff answer (${body.answer})`
          return isSuspectedAnswer && suspectedMember ? `${base} | Member: ${suspectedMember}` : base
        })() })
        .eq('workspace_id', params.id)
        // Bulk only books rows still awaiting a decision — it must never stomp
        // heterogeneous prior bookings (that also keeps undo exact: prior state
        // is uniformly 'uncategorized').
        .in('category', isBulk ? ['uncategorized'] : ['uncategorized', 'expense', 'fee', 'cogs', 'income', 'distribution', 'contribution', 'refund'])
        .in('id', plainAnswerIds.slice(i, i + 200))
        .select('id, description, counterparty, amount')
      if (error) { updateError = error.message; break }
      updatedRows.push(...((data ?? []) as typeof updatedRows))
    }

    // Override telemetry write (fire-and-forget): only when the human CHANGED
    // an AI-applied category — same-category confirmations are agreement.
    const changedOverrides = aiOverrides.filter(o =>
      updatedRows.some(u => u.id === o.id) && o.category !== mapped.category)
    if (changedOverrides.length > 0) {
      try {
        await db.from('action_log').insert({
          actor: user?.email ?? 'staff',
          action_type: 'ai_categorization_override',
          table_name: 'pnl_workspace_transactions',
          record_id: params.id,
          summary: `Staff answer changed ${changedOverrides.length} AI-booked row(s): ${changedOverrides[0].category} → ${mapped.category} (${changedOverrides[0].notes})`,
          details: { workspace_id: params.id, count: changedOverrides.length, from_categories: changedOverrides.map(o => o.category), to_category: mapped.category, ai_versions: Array.from(new Set(changedOverrides.map(o => o.notes))) },
        })
      } catch (e) {
        console.error('[tools/pnl] override telemetry failed (answer saved fine):', e)
      }
    }

    // Bulk audit trail (fire-and-forget): who booked how many groups as what.
    if (isBulk && updatedRows.length > 0) {
      try {
        await db.from('action_log').insert({
          actor: user?.email ?? 'staff',
          action_type: 'bulk_group_answer',
          table_name: 'pnl_workspace_transactions',
          record_id: params.id,
          summary: `Bulk answer: ${updatedRows.length} row(s) booked as ${mapped.category} across ${(body.group_labels ?? []).length || 'several'} group(s)`,
          details: { workspace_id: params.id, answer: body.answer, count: updatedRows.length, group_labels: (body.group_labels ?? []).slice(0, 50) },
        })
      } catch (e) {
        console.error('[tools/pnl] bulk audit log failed (answer saved fine):', e)
      }
    }

    // Auto-learn (fire-and-forget — learning must never fail the answer).
    // NEVER on bulk: permanent per-merchant memory requires a per-merchant
    // decision, not a sweep.
    // Never learn from the owner question — it answers who a PAYMENT went to,
    // not what a MERCHANT is, and here the rule would be written against the
    // REAL client's account from a scratch workspace.
    if (!isBulk && !isSuspectedAnswer && updatedRows.length > 0) {
      try {
        const { data: ws } = await db
          .from('pnl_workspaces')
          .select('linked_account_id')
          .eq('id', params.id)
          .maybeSingle()
        const { upsertLearnedMerchantRules, makeSupabaseRuleStore } = await import('@/lib/tax/learned-rules')
        const scope = ws?.linked_account_id
          ? { account_id: ws.linked_account_id as string }
          : { workspace_id: params.id }
        await upsertLearnedMerchantRules(
          makeSupabaseRuleStore(db),
          scope,
          updatedRows,
          mapped.category,
          mapped.subcategory,
          user?.email ?? 'staff',
        )
      } catch (e) {
        console.error('[tools/pnl] learned-rule write failed (answer saved fine):', e)
      }
    }

    if (updateError) {
      // Post-steps already ran for the rows that DID change; report honestly.
      console.error('[tools/pnl] answer partially failed:', updateError)
      return NextResponse.json(
        { error: `Saved ${updatedRows.length} of ${ids.length} transactions — please retry to finish the rest.`, updated: updatedRows.length },
        { status: 500 },
      )
    }
    return NextResponse.json({ ok: true, updated: updatedRows.length })
  } catch (err) {
    console.error('[tools/pnl] answer failed:', err)
    return NextResponse.json({ error: 'Could not save the answer — please try again.' }, { status: 500 })
  }
}
