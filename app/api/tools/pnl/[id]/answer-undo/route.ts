/**
 * POST /api/tools/pnl/[id]/answer-undo — undo a BULK answer (STAFF ONLY).
 *
 * Bulk answers only ever book rows that were 'uncategorized' (the answer route
 * enforces it), so undo is exact: put the rows back to uncategorized. The
 * notes guard ('manual: bulk %') is server-side — ids from the client can
 * never revert an individually-answered or AI-booked row.
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
    const body = await request.json().catch(() => ({})) as { transaction_ids?: string[] }
    const ids = Array.isArray(body.transaction_ids) ? body.transaction_ids.filter(Boolean) : []
    if (ids.length === 0) return NextResponse.json({ error: 'transaction_ids are required.' }, { status: 400 })

    // Hard-stop parity (2026-08-21, round-3 bug-hunter minor finding): the
    // forward answer route already refuses on a structural problem; undo had
    // no such check — same asymmetry fixed on the portal twin.
    const { getWorkspaceStructuralProblem } = await import('@/lib/tax/workspace-orchestration')
    if (await getWorkspaceStructuralProblem(params.id)) {
      return NextResponse.json({ error: 'This workspace has an unresolved data problem (an unreadable statement, or a missing-months question) — fix that first before changing anything else.' }, { status: 422 })
    }

    let reverted = 0
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await db
        .from('pnl_workspace_transactions')
        .update({ category: 'uncategorized', subcategory: null, notes: null })
        .eq('workspace_id', params.id)
        .like('notes', 'manual: bulk %')
        .in('id', ids.slice(i, i + 200))
        .select('id')
      if (error) throw new Error(error.message)
      reverted += (data ?? []).length
    }

    if (reverted > 0) {
      try {
        await db.from('action_log').insert({
          actor: user?.email ?? 'staff',
          action_type: 'bulk_group_answer_undo',
          table_name: 'pnl_workspace_transactions',
          record_id: params.id,
          summary: `Bulk answer undone: ${reverted} row(s) back to uncategorized`,
          details: { workspace_id: params.id, count: reverted },
        })
      } catch (e) {
        console.error('[tools/pnl] undo audit log failed (undo saved fine):', e)
      }
    }

    return NextResponse.json({ ok: true, reverted })
  } catch (err) {
    console.error('[tools/pnl] answer-undo failed:', err)
    return NextResponse.json({ error: 'Could not undo — please try again.' }, { status: 500 })
  }
}
