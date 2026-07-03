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
    const body = await request.json().catch(() => ({})) as { answer?: string; transaction_ids?: string[] }
    const ids = Array.isArray(body.transaction_ids) ? body.transaction_ids.filter(Boolean) : []
    if (!body.answer || ids.length === 0) {
      return NextResponse.json({ error: 'answer and transaction_ids are required.' }, { status: 400 })
    }

    const { categoryForAnswer } = await import('@/lib/tax/question-groups')
    const mapped = categoryForAnswer(body.answer)
    if (!mapped) return NextResponse.json({ error: `Unknown answer: ${body.answer}` }, { status: 400 })

    // Override telemetry (Phase 0.5): rows the AI auto-booked (notes ai:high@vN)
    // that a human is about to re-answer are the PRODUCTION precision meter —
    // captured BEFORE the update overwrites the notes.
    const { data: preRows } = await db
      .from('pnl_workspace_transactions')
      .select('id, category, notes')
      .eq('workspace_id', params.id)
      .in('id', ids)
      .like('notes', 'ai:high%')
    const aiOverrides = (preRows ?? []) as Array<{ id: string; category: string; notes: string }>

    // Only re-file rows still in a reviewable state (never override a prior
    // manual decision by re-answering a stale group), scoped to this workspace.
    const { data, error } = await db
      .from('pnl_workspace_transactions')
      .update({ category: mapped.category, subcategory: mapped.subcategory, notes: `manual: staff answer (${body.answer})` })
      .eq('workspace_id', params.id)
      .in('category', ['uncategorized', 'expense', 'fee', 'cogs', 'income', 'distribution', 'contribution'])
      .in('id', ids)
      .select('id, description, counterparty, amount')
    if (error) throw new Error(error.message)
    const updatedRows = (data ?? []) as Array<{ id: string; description: string | null; counterparty: string | null; amount: number | string }>

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

    // Auto-learn (fire-and-forget — learning must never fail the answer).
    if (updatedRows.length > 0) {
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

    return NextResponse.json({ ok: true, updated: updatedRows.length })
  } catch (err) {
    console.error('[tools/pnl] answer failed:', err)
    return NextResponse.json({ error: 'Could not save the answer — please try again.' }, { status: 500 })
  }
}
