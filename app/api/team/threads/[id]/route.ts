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
 *
 * `?mark_read=0` fetches WITHOUT advancing the pointer. Reading is otherwise a
 * WRITE here, which is fine for the Team Chat page (you opened it, you read it)
 * but wrong for any surface that can render a thread you did not ask to see: a
 * window that auto-opens, or polls, or sits minimized would clear the badge —
 * and `manual_unread` with it — for a message no human ever looked at. The push
 * has already fired by then, so the message is simply lost. Such a surface must
 * pass mark_read=0 and call POST .../read on a real human signal instead.
 * Default stays ON so every existing caller is byte-identical.
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
  const replyQuery = (cols: string) => (supabaseAdmin as any)
    .from('internal_messages')
    .select(cols)
    .eq('thread_id', threadId)
    .not('root_id', 'is', null)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
  const firstTry = await replyQuery('root_id, created_at, sender_id, sender_name, on_behalf_of_user_id')
  let replyRows = firstTry.data
  if (firstTry.error) {
    // Deploy-before-DDL window: on_behalf_of_user_id may not exist yet (prod
    // migration is run by hand in the SQL editor). Degrade to the old
    // projection rather than breaking the thread read. Migration 20260729-1900.
    ;({ data: replyRows } = await replyQuery('root_id, created_at, sender_id, sender_name'))
  }
  const rootIds = Array.from(new Set(((replyRows ?? []) as { root_id: string }[]).map(r => r.root_id)))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rootReads: any[] = []
  if (rootIds.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabaseAdmin as any)
      .from('internal_root_reads')
      .select('root_message_id, last_read_at, manual_unread')
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
  // The COMPLETE set of archived roots in this channel — deliberately NOT
  // derived from `threads[]` below. That list is a FILTERED view (archived rows
  // are dropped from it unless the archive view is on), so reading the archived
  // set off it yields an empty set exactly when the stream needs it most, and
  // the archived thread keeps rendering in the channel. This looked like
  // duplicated information and was removed once on that reasoning; it is not
  // duplication — one is a filtered list, this is the full set. Do not fold them
  // together again.
  const archivedRootIds = Array.from(stateMap.entries())
    .filter(([, st]) => !!st.archived_at)
    .map(([rid]) => rid)
  // Which of these threads THIS user follows (presence = following).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: followRows } = await (supabaseAdmin as any)
    .from('internal_root_follows')
    .select('root_message_id')
    .eq('user_id', user.id)
  const followSet = new Set<string>(((followRows ?? []) as { root_message_id: string }[]).map(f => f.root_message_id))
  // Personal "bring forward" flags (presence = flagged).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: laterRows } = await (supabaseAdmin as any)
    .from('internal_root_later')
    .select('root_message_id')
    .eq('user_id', user.id)
  const laterSet = new Set<string>(((laterRows ?? []) as { root_message_id: string }[]).map(l => l.root_message_id))
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
  // Threads the caller marked unread by hand — unread even with no new replies.
  const manualUnreadRoots = new Set<string>()
  if (panelRootIds.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: prr } = await (supabaseAdmin as any)
      .from('internal_root_reads')
      .select('root_message_id, last_read_at, manual_unread')
      .eq('user_id', user.id)
      .in('root_message_id', panelRootIds)
    for (const r of (prr ?? []) as { root_message_id: string; last_read_at: string; manual_unread: boolean | null }[]) {
      panelReadMap.set(r.root_message_id, r.last_read_at)
      if (r.manual_unread) manualUnreadRoots.add(r.root_message_id)
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
      unread: (meta?.unread ?? false) || rootUnread || manualUnreadRoots.has(rid),
      status: st?.status ?? 'todo',
      assignee_id: st?.assignee_id ?? null,
      following: followSet.has(rid),
      later: laterSet.has(rid),
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

  // Advance the caller's read pointer (per-user unread model) — unless the caller
  // explicitly opted out with ?mark_read=0. See the route doc: a surface that can
  // show a thread the user never asked for must not mark it read by looking at it.
  if (request.nextUrl.searchParams.get('mark_read') !== '0') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabaseAdmin as any)
      .from('internal_thread_reads')
      .upsert(
        { thread_id: threadId, user_id: user.id, last_read_at: new Date().toISOString(), manual_unread: false, updated_at: new Date().toISOString() },
        { onConflict: 'thread_id,user_id' },
      )
  }

  // Read-receipt / "whose turn" state for every listed thread — the same shared
  // calculation used by the board and the Later list, so the four surfaces can
  // never disagree. Attached to the panel rows AND folded into thread_meta so the
  // in-stream "replies" affordance can show it too.
  const { enrichThreadTurn } = await import('@/lib/team/thread-turn-server')
  const turnMap = await enrichThreadTurn(panelRootIds, user.id)
  for (const t of threads) {
    const turn = turnMap[t.root_id]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(t as any).read_state = turn?.read_state ?? 'none'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(t as any).waiting_name = turn?.waiting_name ?? null
  }
  for (const rid of Object.keys(threadMeta)) {
    const turn = turnMap[rid]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(threadMeta as any)[rid].read_state = turn?.read_state ?? 'none'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(threadMeta as any)[rid].waiting_name = turn?.waiting_name ?? null
  }

  return NextResponse.json({
    thread,
    messages: enriched,
    thread_meta: threadMeta,
    threads,
    archived_roots: archivedRootIds,
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
