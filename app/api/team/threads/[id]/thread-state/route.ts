import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { isValidWorkStatus } from '@/lib/team/workspace'
import { normalizeThreadTitle } from '@/lib/team/thread-title'
import { listTeamMembers } from '@/lib/team/directory'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/team/threads/[id]/thread-state
 * Set a thread's status, assignee, and/or name (the Threads panel).
 * Body: { root_id, status?, assignee_id?, title? } — PARTIAL: only the fields
 * PROVIDED are written, so setting an assignee never clobbers the status, and a
 * status change can never blank someone else's rename. `assignee_id: null`
 * clears the assignee; a blank `title` clears the name (falling back to the
 * opening message). The row is never deleted — see the note further down.
 * Staff-only; channels and general only (DMs / client discussions have no panel).
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
  const titleProvided = 'title' in body
  if (!statusProvided && !assigneeProvided && !titleProvided) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
  }
  if (statusProvided && !isValidWorkStatus(body.status)) {
    return NextResponse.json({ error: 'invalid status' }, { status: 400 })
  }
  // Rename. A blank name CLEARS it (falls back to the opening message).
  let nextTitle: string | null = null
  if (titleProvided) {
    const normalized = normalizeThreadTitle(body.title)
    if ('error' in normalized) return NextResponse.json({ error: normalized.error }, { status: 400 })
    nextTitle = normalized.title
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

  // status is NOT NULL, so an INSERT must carry one. Read the current value ONLY
  // for that case — every other field is written only when the caller sent it,
  // so there is nothing else to merge.
  let finalStatus: string = body.status
  if (!statusProvided) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existing } = await (supabaseAdmin as any)
      .from('internal_thread_state')
      .select('status')
      .eq('root_message_id', rootId)
      .maybeSingle()
    finalStatus = existing?.status ?? 'todo'
  }

  const now = new Date().toISOString()
  // NO sparse delete. This route used to DELETE the row whenever a thread went
  // back to Open with no assignee, to keep the table sparse. That habit caused
  // three separate bugs — a created thread vanishing, a rename reverting, an
  // archive undoing itself — each patched by adding one more term to a
  // "don't delete if…" guard that would have kept growing with every new
  // column, and that a concurrent write could lose a race against anyway.
  //
  // Rows are now simply kept. Nothing reads "row exists" as meaning anything:
  // every list asks whether the row is MEANINGFUL (threadStateIsMeaningful, and
  // the matching WHERE clause in migration 20260718-1400), so an all-default row
  // is indistinguishable from no row. One row per touched thread in a two-person
  // staff chat costs nothing.
  //
  // Only the fields the caller actually sent are written, so a status change can
  // never blank a rename made a moment earlier by someone else.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload: Record<string, any> = {
    root_message_id: rootId, thread_id: threadId, updated_at: now, updated_by: user.id,
    // status is NOT NULL, so a first insert must carry one.
    status: finalStatus,
  }
  if (assigneeProvided) payload.assignee_id = nextAssignee
  if (titleProvided) payload.title = nextTitle

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabaseAdmin as any)
    .from('internal_thread_state')
    .upsert(payload, { onConflict: 'root_message_id' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, status: finalStatus, assignee_id: nextAssignee ?? null, title: nextTitle })
}
