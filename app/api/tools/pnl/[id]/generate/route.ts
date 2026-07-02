/**
 * POST /api/tools/pnl/[id]/generate — stamp a workspace as generated (STAFF ONLY).
 *
 * The workspace opens in UPLOAD mode (Antonio, 2026-07-02): statements are
 * uploaded and parsed in the background, but NO P&L is rendered until staff
 * press "Generate P&L". This route is that button:
 *   1. refuses while any ingest job for the workspace is still running
 *      (409 — the UI shows "still processing N file(s)"),
 *   2. stamps `generated_at` so the GET switches from the upload manager to
 *      the review view,
 *   3. (Phase 3 hook) this is where the AI categorization pass is enqueued —
 *      one pass per batch instead of one per file, so it never runs on a
 *      partial upload set.
 *
 * Re-pressing it later ("Regenerate" after adding more statements) is the
 * same action — idempotent, just a fresh stamp.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const workspaceId = params.id
  try {
    const { data: ws } = await db
      .from('pnl_workspaces')
      .select('id')
      .eq('id', workspaceId)
      .maybeSingle()
    if (!ws) return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 })

    // Same per-path pending logic as the GET view: a file is pending unless a
    // completed-ok job exists for its path.
    const { data: ingestJobs } = await supabaseAdmin
      .from('job_queue')
      .select('status, result, payload')
      .eq('job_type', 'ingest_workspace_statement')
      .eq('related_entity_id', workspaceId)
      .in('status', ['pending', 'processing', 'completed'])
    const byPath = new Map<string, { succeeded: boolean; pending: boolean }>()
    for (const j of (ingestJobs ?? []) as Array<{ status: string; result: { ok?: boolean } | null; payload: { path?: string } | null }>) {
      const path = j.payload?.path
      if (!path) continue
      const e = byPath.get(path) ?? { succeeded: false, pending: false }
      if (j.status === 'completed' && j.result?.ok !== false) e.succeeded = true
      else if (j.status === 'pending' || j.status === 'processing') e.pending = true
      byPath.set(path, e)
    }
    const stillPending = Array.from(byPath.values()).filter(e => !e.succeeded && e.pending).length
    if (stillPending > 0) {
      return NextResponse.json(
        { error: `${stillPending} statement(s) are still processing — wait for them to finish, then generate.`, pending: stillPending },
        { status: 409 },
      )
    }

    const { error } = await db
      .from('pnl_workspaces')
      .update({ generated_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', workspaceId)
    if (error) throw new Error(error.message)

    // Phase 3 hook: AI-assist on whatever the deterministic passes left
    // uncategorized — enqueued HERE (one pass per generation, never on a
    // partial upload set). DIRECT insert with a pending-guard, never
    // enqueueJobs() (its dangling triggerWorker fetch outlives the response —
    // the documented Vercel teardown bug, 2026-06-26). The 5-min process-jobs
    // cron drains it; the GET reports it as aiPending so the UI shows progress.
    let aiQueued = false
    try {
      const { count: uncategorized } = await db
        .from('pnl_workspace_transactions')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('category', 'uncategorized')
      if ((uncategorized ?? 0) > 0) {
        const { data: existing } = await supabaseAdmin
          .from('job_queue')
          .select('id')
          .eq('job_type', 'recategorize_workspace_ai')
          .eq('related_entity_id', workspaceId)
          .in('status', ['pending', 'processing'])
          .limit(1)
        if (!existing || existing.length === 0) {
          await supabaseAdmin.from('job_queue').insert({
            job_type: 'recategorize_workspace_ai',
            payload: { workspace_id: workspaceId },
            related_entity_id: workspaceId,
            created_by: 'pnl_generate',
          } as never)
        }
        aiQueued = true
      }
    } catch (e) {
      console.error('[tools/pnl] failed to enqueue workspace AI categorization (generation still stamped):', e)
    }

    return NextResponse.json({ ok: true, aiQueued })
  } catch (err) {
    console.error('[tools/pnl] generate failed:', err)
    return NextResponse.json({ error: 'Could not generate — please try again.' }, { status: 500 })
  }
}
