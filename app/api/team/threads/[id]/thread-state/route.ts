import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { isValidWorkStatus } from '@/lib/team/workspace'
import { listTeamMembers } from '@/lib/team/directory'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/team/threads/[id]/thread-state
 * Set a thread's management status and/or assignee (the Threads panel).
 * Body: { root_id, status?, assignee_id? } — PARTIAL: only the fields provided
 * change, so setting an assignee never clobbers the status (and vice versa).
 * `assignee_id: null` clears the assignee. Reverting to the default status with
 * no assignee DELETES the row (keeps the table sparse). Staff-only; channels
 * and general only (DMs / client discussions don't have this panel).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }
  const { id: threadId } = await params
  const body = await request.json().catch(() => ({}))

  const rootId: string | null = (body.root_id ?? '').toString().trim() || null
  if (!rootId) return NextResponse.json({ error: 'root_id required' }, { status: 400 })

  const statusProvided = 'status' in body
  const assigneeProvided = 'assignee_id' in body
  if (!statusProvided && !assigneeProvided) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  }
  if (statusProvided && !isValidWorkStatus(body.status)) {
    return NextResponse.json({ error: 'invalid status' }, { status: 400 })
  }
  const nextAssignee: string | null = assigneeProvided ? (body.assignee_id ?? null) : undefined as unknown as string | null

  // The root must belong to this thread, and the thread must be a channel/general
  // (the only surfaces with the Threads panel).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: thread } = await (supabaseAdmin as any)
    .from('internal_threads')
    .select('id, thread_type')
    .eq('id', threadId)
    .single()
  if (!thread || (thread.thread_type !== 'channel' && thread.thread_type !== 'general')) {
    return NextResponse.json({ error: 'Threads are managed on channels only.' }, { status: 400 })
  }
  const { data: root } = await supabaseAdmin
    .from('internal_messages')
    .select('id')
    .eq('id', rootId)
    .eq('thread_id', threadId)
    .single()
  if (!root) return NextResponse.json({ error: 'thread not found in this channel' }, { status: 404 })

  // Validate the assignee is a real staff member (mirrors sender having no FK).
  if (assigneeProvided && nextAssignee) {
    const members = await listTeamMembers()
    if (!members.some(m => m.id === nextAssignee)) {
      return NextResponse.json({ error: 'assignee is not a staff member' }, { status: 400 })
    }
  }

  // Partial merge against the existing row.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existing } = await (supabaseAdmin as any)
    .from('internal_thread_state')
    .select('status, assignee_id, created_as_thread')
    .eq('root_message_id', rootId)
    .maybeSingle()

  const finalStatus: string = statusProvided ? body.status : (existing?.status ?? 'todo')
  const finalAssignee: string | null = assigneeProvided ? nextAssignee : (existing?.assignee_id ?? null)

  const now = new Date().toISOString()
  // Sparse: default status + no assignee ⇒ no row — EXCEPT for a thread that was
  // deliberately created ("+ New thread"). Its row IS its existence, so deleting
  // it on a revert-to-Open would make the thread silently disappear from every
  // list until someone replied (the exact confusion this feature exists to fix).
  if (finalStatus === 'todo' && !finalAssignee && !existing?.created_as_thread) {
    if (existing) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabaseAdmin as any).from('internal_thread_state').delete().eq('root_message_id', rootId)
    }
    return NextResponse.json({ ok: true, status: 'todo', assignee_id: null })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabaseAdmin as any)
    .from('internal_thread_state')
    .upsert(
      { root_message_id: rootId, thread_id: threadId, status: finalStatus, assignee_id: finalAssignee, updated_at: now, updated_by: user.id },
      { onConflict: 'root_message_id' },
    )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, status: finalStatus, assignee_id: finalAssignee })
}
