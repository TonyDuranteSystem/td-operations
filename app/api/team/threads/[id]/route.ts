import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser, isAdmin, getUserDisplayName } from '@/lib/auth'
import { isValidWorkStatus } from '@/lib/team/workspace'
import { resolveThreadTitle, threadStateIsMeaningful } from '@/lib/team/thread-title'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/team/threads/[id]
 * Full message history for a thread (newest 500), reply previews enriched, and
 * the caller's read pointer advanced (upsert internal_thread_reads.last_read_at).
 * Staff-only. Soft-deleted rows are returned so the UI can render tombstones.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }
  const { id: threadId } = await params

  const { data: thread } = await supabaseAdmin
    .from('internal_threads')
    .select('*')
    .eq('id', threadId)
    .single()
  if (!thread) {
    return NextResponse.json({ error: 'Thread not found' }, { status: 404 })
  }

  // Load the NEWEST 500 (desc + limit), then flip to oldest→newest for display.
  // (The old code ordered ascending + limit, which returned the OLDEST 500 and
  // dropped the current conversation on long-lived channels.)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rawMessages } = await (supabaseAdmin as any)
    .from('internal_messages')
    .select('*')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: false })
    .limit(500)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages = ((rawMessages ?? []) as any[]).reverse()

  // Reply previews.
  const replyIds = Array.from(new Set(messages.filter(m => m.reply_to_id).map(m => m.reply_to_id)))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parentMap = new Map<string, any>()
  if (replyIds.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: parents } = await (supabaseAdmin as any)
      .from('internal_messages')
      .select('id, message, sender_name, deleted_at')
      .in('id', replyIds)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(parents ?? []).forEach((p: any) => parentMap.set(p.id, p))
  }
  const enriched = messages.map(m => ({
    ...m,
    reply_to_preview: m.reply_to_id ? (parentMap.get(m.reply_to_id) ?? null) : null,
  }))

  // Per-root thread metadata (Slack threads): reply counts + last reply + this
  // caller's unread-replies signal. Computed over ALL replies in the thread
  // (narrow projection, not the loaded window) so counts are accurate even when
  // the window is capped.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: replyRows } = await (supabaseAdmin as any)
    .from('internal_messages')
    .select('root_id, created_at, sender_id, sender_name')
    .eq('thread_id', threadId)
    .not('root_id', 'is', null)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
  const rootIds = Array.from(new Set(((replyRows ?? []) as { root_id: string }[]).map(r => r.root_id)))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rootReads: any[] = []
  if (rootIds.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabaseAdmin as any)
      .from('internal_root_reads')
      .select('root_message_id, last_read_at')
      .eq('user_id', user.id)
      .in('root_message_id', rootIds)
    rootReads = data ?? []
  }
  const { computeThreadMeta } = await import('@/lib/team/thread-meta')
  const threadMeta = computeThreadMeta((replyRows ?? []), rootReads, user.id)

  // ── Thread management state (status + assignee) for the Threads panel ──────
  // Per-thread status/assignee live in their own sparse table; a thread with no
  // row reads as the default 'todo'. "New" stays derived from unread above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: stateRows, error: stateErr } = await (supabaseAdmin as any)
    .from('internal_thread_state')
    .select('root_message_id, status, assignee_id, title, created_as_thread, archived_at, archived_by')
    .eq('thread_id', threadId)
  // FAIL LOUDLY. Swallowing this returns 200 with an empty state map, which
  // silently strips every thread's name, stage, assignee and archive flag — the
  // workspace looks like it forgot everything, with no error anywhere. That is
  // exactly how a missing database change would ship unnoticed (council).
  if (stateErr) {
    return NextResponse.json(
      { error: 'Thread details are unavailable — the database may be missing a recent update.' },
      { status: 500 },
    )
  }
  const stateMap = new Map<string, { status: string; assignee_id: string | null; title: string | null; created_as_thread: boolean; archived_at: string | null; archived_by: string | null }>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const s of (stateRows ?? []) as any[]) {
    stateMap.set(s.root_message_id, { status: s.status, assignee_id: s.assignee_id, title: s.title ?? null, created_as_thread: !!s.created_as_thread, archived_at: s.archived_at ?? null, archived_by: s.archived_by ?? null })
  }
  // Archived threads are hidden everywhere unless explicitly asked for (the
  // panel's "Show archived" toggle) — including from the channel stream, so
  // "remove this thread" actually removes it from view.
  const includeArchived = request.nextUrl.searchParams.get('include_archived') === '1'
  // Which of these threads THIS user follows (presence = following).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: followRows } = await (supabaseAdmin as any)
    .from('internal_root_follows')
    .select('root_message_id')
    .eq('user_id', user.id)
  const followSet = new Set<string>(((followRows ?? []) as { root_message_id: string }[]).map(f => f.root_message_id))
  // Fold status/assignee into thread_meta (so the in-stream affordance can show
  // a pill too).
  for (const rid of Object.keys(threadMeta)) {
    const st = stateMap.get(rid)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(threadMeta as any)[rid].status = st?.status ?? 'todo'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(threadMeta as any)[rid].assignee_id = st?.assignee_id ?? null
  }

  // Panel list = every root that is a thread (has replies) OR carries a state
  // row that MEANS something — named, archived, triaged, assigned, or created on
  // purpose. Keying on the row merely EXISTING left a restored-or-untriaged row
  // showing as a phantom thread with no replies (council). Titles come from a
  // NARROW query by root id — NEVER the capped message window — so old-but-active
  // threads still show a title; a soft-deleted root renders a tombstone.
  const meaningfulStateIds = Array.from(stateMap.entries())
    .filter(([, st]) => threadStateIsMeaningful(st))
    .map(([rid]) => rid)
  const panelRootIds = Array.from(new Set([...Object.keys(threadMeta), ...meaningfulStateIds]))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rootTitleMap = new Map<string, any>()
  if (panelRootIds.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rootRows } = await (supabaseAdmin as any)
      .from('internal_messages')
      // sender_id is REQUIRED here — the "is this new for me" test below compares
      // it to the caller. Omitting it (the shipped bug) made `sender_id !== user.id`
      // true for every row, so your OWN new thread showed as unread to you.
      .select('id, message, sender_id, sender_name, deleted_at, created_at')
      .in('id', panelRootIds)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const r of (rootRows ?? []) as any[]) rootTitleMap.set(r.id, r)
  }
  // This caller's per-root read pointers for EVERY listed thread (not just the
  // reply-derived ones) — needed so a brand-new thread with no replies can still
  // read as unread.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const panelReadMap = new Map<string, string>()
  if (panelRootIds.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: prr } = await (supabaseAdmin as any)
      .from('internal_root_reads')
      .select('root_message_id, last_read_at')
      .eq('user_id', user.id)
      .in('root_message_id', panelRootIds)
    for (const r of (prr ?? []) as { root_message_id: string; last_read_at: string }[]) {
      panelReadMap.set(r.root_message_id, r.last_read_at)
    }
  }

  const threads = panelRootIds
    .filter(rid => includeArchived || !stateMap.get(rid)?.archived_at)
    .map(rid => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (threadMeta as any)[rid]
    const st = stateMap.get(rid)
    const root = rootTitleMap.get(rid)
    // ONE resolver, shared with the SQL lists: a named thread owns its title, a
    // derived one falls back to the opening message, tombstone-safe.
    const title = root
      ? resolveThreadTitle({ stateTitle: st?.title, rootMessage: root.message, rootDeleted: !!root.deleted_at })
      : (st?.title || 'Unavailable')
    // New for me = an unseen reply from someone else, OR an unseen opening
    // message from someone else (so a brand-new thread shows bold + dot).
    const lastRead = panelReadMap.get(rid)
    const rootUnread = !!root && !root.deleted_at && root.sender_id !== user.id
      && (!lastRead || String(root.created_at) > lastRead)
    return {
      root_id: rid,
      title,
      sender_name: root?.sender_name ?? null,
      reply_count: meta?.reply_count ?? 0,
      last_reply_at: meta?.last_reply_at ?? root?.created_at ?? null,
      unread: (meta?.unread ?? false) || rootUnread,
      status: st?.status ?? 'todo',
      assignee_id: st?.assignee_id ?? null,
      following: followSet.has(rid),
      archived: !!st?.archived_at,
      // WHO hid it and WHEN — an archive removes a thread from everyone's view,
      // so the archived list must say who did it (council).
      archived_at: st?.archived_at ?? null,
      archived_by: st?.archived_by ?? null,
      // Who opened it — the UI offers Delete only to that person (and only
      // while nobody else has replied); everyone else gets Archive.
      root_sender_id: root?.sender_id ?? null,
    }
  })

  // Advance the caller's read pointer (per-user unread model).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from('internal_thread_reads')
    .upsert(
      { thread_id: threadId, user_id: user.id, last_read_at: new Date().toISOString(), manual_unread: false, updated_at: new Date().toISOString() },
      { onConflict: 'thread_id,user_id' },
    )

  return NextResponse.json({
    thread,
    messages: enriched,
    thread_meta: threadMeta,
    threads,
    current_user_id: user.id,
    current_user_name: getUserDisplayName(user),
    is_admin: isAdmin(user),
  })
}

/**
 * PATCH /api/team/threads/[id]
 * Update a channel/discussion: rename, recolor, resolve/unresolve, archive.
 * Body: { channel_name?, description?, color?, resolved?: boolean, archived?: boolean }
 */
export async function PATCH(
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patch: Record<string, any> = {}
  if (typeof body.channel_name === 'string') patch.channel_name = body.channel_name.trim()
  if (typeof body.description === 'string') patch.description = body.description.trim() || null
  if (typeof body.color === 'string') patch.color = body.color.trim() || null
  if (typeof body.resolved === 'boolean') patch.resolved_at = body.resolved ? new Date().toISOString() : null
  if (typeof body.archived === 'boolean') patch.archived_at = body.archived ? new Date().toISOString() : null
  // Move to (or out of) a channel folder.
  if ('channel_id' in body) patch.parent_channel_id = body.channel_id || null
  // Kanban status. 'handled' IS the done state → keep resolved_at in sync so
  // anything reading resolved_at (and the resolve toggle) stays consistent.
  if (isValidWorkStatus(body.work_status)) {
    patch.work_status = body.work_status
    patch.resolved_at = body.work_status === 'handled' ? new Date().toISOString() : null
  }
  // Conversation lifecycle (orthogonal to the kanban lane): Solved / Closed /
  // reopen. Solved+Closed both stamp resolved_at (keeps the shared "open"
  // predicate working) + resolved_by + move the kanban card to Done; the
  // distinction lives in `resolution`. Reopen (null) clears all three and
  // returns the card to To-do.
  if ('resolution' in body) {
    const res = body.resolution
    if (res === 'solved' || res === 'closed') {
      patch.resolution = res
      patch.resolved_at = new Date().toISOString()
      patch.resolved_by = user.id
      patch.work_status = 'handled'
    } else if (res === null) {
      patch.resolution = null
      patch.resolved_at = null
      patch.resolved_by = null
      patch.work_status = 'todo'
    } else {
      return NextResponse.json({ error: 'resolution must be "solved", "closed", or null.' }, { status: 400 })
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No changes provided' }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: thread, error } = await (supabaseAdmin as any)
    .from('internal_threads')
    .update(patch)
    .eq('id', threadId)
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ thread })
}
