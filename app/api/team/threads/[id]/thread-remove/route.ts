import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/** Shared guard: the root must belong to this thread, and the thread must be a channel/general. */
async function resolveRoot(threadId: string, rootId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: thread } = await (supabaseAdmin as any)
    .from('internal_threads')
    .select('id, thread_type')
    .eq('id', threadId)
    .single()
  if (!thread || (thread.thread_type !== 'channel' && thread.thread_type !== 'general')) {
    return { error: 'Threads are managed on channels only.', status: 400 as const }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: root } = await (supabaseAdmin as any)
    .from('internal_messages')
    .select('id, sender_id, root_id')
    .eq('id', rootId)
    .eq('thread_id', threadId)
    .single()
  if (!root) return { error: 'Thread not found in this channel.', status: 404 as const }
  // Must be a ROOT. Archiving a REPLY would key a state row on a reply id,
  // which then shows up in the panel as a phantom thread (council).
  if (root.root_id) return { error: 'That is a reply, not a thread.', status: 400 as const }
  return { root }
}

/**
 * POST /api/team/threads/[id]/thread-remove
 * ARCHIVE or restore a thread. Body: { root_id, archived: boolean }
 *
 * Archive is the DEFAULT removal (Antonio chose it over true delete): the
 * thread disappears from the channel stream, the Threads panel, the board, and
 * the followed-unread dot — but nothing is destroyed and it can be brought
 * back. Any staff member may archive; it is reversible and this workspace is
 * staff-only.
 *
 * The marker is POSITIVE (`archived_at`), never "the state row is missing" —
 * absence resurrects on the next reply and has no restore path (council).
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
  if (typeof body.archived !== 'boolean') {
    return NextResponse.json({ error: 'archived must be true or false' }, { status: 400 })
  }

  const resolved = await resolveRoot(threadId, rootId)
  if ('error' in resolved) return NextResponse.json({ error: resolved.error }, { status: resolved.status })

  const now = new Date().toISOString()
  // Upsert, not update: an untriaged thread has no state row yet, and archiving
  // it must still stick. Columns omitted here (status / title / assignee) are
  // PRESERVED on conflict — verified empirically against sandbox, not assumed —
  // so archiving never wipes a rename.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabaseAdmin as any)
    .from('internal_thread_state')
    .upsert(
      {
        root_message_id: rootId,
        thread_id: threadId,
        archived_at: body.archived ? now : null,
        archived_by: body.archived ? user.id : null,
        updated_at: now,
        updated_by: user.id,
      },
      { onConflict: 'root_message_id' },
    )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  // On RESTORE the row is deliberately KEPT (archived_at set back to null)
  // rather than deleted. Deleting it was the old "stay sparse" habit that
  // silently reverted renames; and a leftover all-default row no longer strands
  // a stray message on the board, because every list now keys on MEANINGFUL
  // state rather than on a row merely existing (migration 20260718-1400).
  return NextResponse.json({ ok: true, archived: body.archived })
}

/**
 * DELETE /api/team/threads/[id]/thread-remove?root_id=...
 * TRUE delete — only while the caller is the ONLY person who has posted.
 *
 * Deliberately narrow: deleting a thread that carries someone else's words
 * destroys their content with no restore, which is precisely what archive
 * exists for. Anything else gets a 409 telling the caller to archive instead.
 * Admins get no override here — an admin deleting a colleague's replies is the
 * data-loss case, not an exception to it.
 *
 * Hard (not soft) delete is right ONLY under that precondition: a soft-deleted
 * root would leave a "Message deleted" tombstone in the channel forever, which
 * is not what "delete this thread" means to the person clicking it.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }
  const { id: threadId } = await params
  const rootId = request.nextUrl.searchParams.get('root_id')
  if (!rootId) return NextResponse.json({ error: 'root_id required' }, { status: 400 })

  const resolved = await resolveRoot(threadId, rootId)
  if ('error' in resolved) return NextResponse.json({ error: resolved.error }, { status: resolved.status })

  // The guard and the delete run INSIDE one transaction (SQL function). Doing
  // the check here and the delete in a second round-trip left a window wide
  // enough for a teammate's reply to land and be destroyed — the exact outcome
  // archive exists to prevent. This route only maps the outcome to a message.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: outcome, error } = await (supabaseAdmin as any)
    .rpc('delete_thread_if_sole_author', { p_root_id: rootId, p_user_id: user.id })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  switch (outcome) {
    case 'deleted':
      return NextResponse.json({ ok: true, deleted: true })
    case 'not_found':
      return NextResponse.json({ error: 'Thread not found.' }, { status: 404 })
    case 'not_a_thread':
      return NextResponse.json({ error: 'That is a reply, not a thread.' }, { status: 400 })
    case 'not_author':
      return NextResponse.json({ error: 'Only the person who started a thread can delete it. Archive it instead.' }, { status: 403 })
    case 'has_other_replies':
      return NextResponse.json(
        { error: 'Someone else has replied here, so this thread can only be archived — deleting it would remove their messages too.' },
        { status: 409 },
      )
    default:
      return NextResponse.json({ error: 'Could not delete the thread.' }, { status: 500 })
  }
}
