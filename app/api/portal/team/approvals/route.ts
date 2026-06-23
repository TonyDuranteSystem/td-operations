/**
 * Staff-only API for the agent action-approval queue.
 *
 * GET  → list pending proposals (the assistant's queued actions).
 * POST → decide one: { id, decision: 'approve' | 'reject' }.
 *
 * Auth: TD STAFF only — a Supabase user whose app_metadata.role !== 'client'
 * (same staff distinction as lib/portal/team/gate.ts:72). These are INTERNAL
 * agent-approvals, not client-scoped data, so clients/teammates must never see them.
 *
 * Security model: approving here does NOT require the 6-digit confirmation code that
 * the text-channel (approval_decide) path uses — the per-proposal Approve button on
 * an authenticated staff session provides the same "bound to exactly this action"
 * guarantee the code provides in a chat. The flip is atomic (guarded on status
 * 'pending'). Approving only sets status='approved'; the async executor (Mac Mini
 * claim or the server cron backup) runs the action — we never execute inline here.
 */
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/** True for TD staff (Antonio / Luca), false for client/teammate users. */
function isStaff(user: { app_metadata?: Record<string, unknown> } | null): boolean {
  return !!user && (user.app_metadata as Record<string, unknown> | undefined)?.role !== 'client'
}

export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isStaff(user)) return NextResponse.json({ error: 'Staff only' }, { status: 403 })

  const { data, error } = await supabaseAdmin
    .from('approval_queue')
    .select('id, tool_name, params, rationale, created_at, expires_at, requested_by')
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(100)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ proposals: data ?? [] })
}

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isStaff(user)) return NextResponse.json({ error: 'Staff only' }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const id = typeof body.id === 'string' ? body.id : ''
  const decision = body.decision === 'approve' ? 'approve' : body.decision === 'reject' ? 'reject' : ''
  if (!id || !decision) {
    return NextResponse.json({ error: 'id and decision ("approve" | "reject") are required.' }, { status: 400 })
  }

  const newStatus = decision === 'approve' ? 'approved' : 'rejected'
  // eslint-disable-next-line no-restricted-syntax -- internal agent-approval rail; staff-gated above; atomic guard on status='pending'.
  const { data, error } = await supabaseAdmin
    .from('approval_queue')
    .update({ status: newStatus, decided_by: user.email ?? 'antonio', decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'pending')
    .select('id, tool_name')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data || data.length === 0) {
    return NextResponse.json({ error: 'This proposal was already decided or has expired.' }, { status: 409 })
  }
  return NextResponse.json({ ok: true, id, decision, tool_name: data[0].tool_name })
}
