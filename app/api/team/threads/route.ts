import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser, isAdmin, getUserDisplayName } from '@/lib/auth'
import { listTeamMembers } from '@/lib/team/directory'
import { everMentionedThreadIds } from '@/lib/team/chat-window-threads'
import { NextResponse } from 'next/server'

/**
 * GET /api/team/threads
 * Team Workspace sidebar payload: every channel / DM / discussion / general room
 * the current user can see, with PER-USER unread counts (via get_team_threads),
 * plus the staff directory (for DMs + @mention autocomplete) and the caller's
 * identity. Staff-only.
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: threads, error } = await (supabaseAdmin as any)
    .rpc('get_team_threads', { p_user_id: user.id })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Labels come from the RPC itself (accounts/contacts/leads joined server-side,
  // one query) — the old per-thread lookups here were an N+1 that would degrade
  // first as client count grows (panel review of Luca's proposal, 2026-07-08).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // "Later" now lives in its own sparse table (parking a thread must never mark
  // it read — see the later route). get_team_threads still projects the OLD
  // column, which is frozen and no longer written, so overlay the real value
  // here rather than rewriting the function. When that column is finally
  // dropped, this overlay becomes the function's own job and can go.
  const laterSet = new Set<string>()
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rows } = await (supabaseAdmin as any)
      .from('internal_thread_later')
      .select('thread_id')
      .eq('user_id', user.id)
    for (const r of rows ?? []) if (r?.thread_id) laterSet.add(r.thread_id)
  } catch {
    // Best-effort: a Later lookup failure must not empty the whole sidebar.
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const enriched = (threads ?? []).map((t: any) => ({
    ...t,
    label: t.label ?? 'Thread',
    later: laterSet.has(t.id),
  }))

  // Read-receipt / "whose turn" for whole conversations — DMs and client
  // discussions only (channels/general carry per-thread receipts inside them, so
  // a conversation-level badge there would be meaningless). Same shared
  // calculation as the channel-thread receipts, at conversation grain.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const convoIds = enriched.filter((t: any) => t.thread_type === 'dm' || t.thread_type === 'discussion').map((t: any) => t.id)
  if (convoIds.length > 0) {
    // Best-effort, like the Later lookup above: a cosmetic receipt must NEVER
    // take down the whole sidebar (threads + members + identity). A query error
    // is already handled inside (returns {}), but a fetch-layer reject or import
    // failure would throw — so guard it and just ship no badges on failure.
    try {
      const { enrichConversationTurn } = await import('@/lib/team/thread-turn-server')
      const turnMap = await enrichConversationTurn(convoIds, user.id)
      for (const t of enriched) {
        const turn = turnMap[t.id]
        if (turn) { t.read_state = turn.read_state; t.waiting_name = turn.waiting_name }
      }
    } catch (e) {
      console.error('team/threads: conversation read-receipt enrichment failed', e)
    }
  }

  // "Mine" for a client conversation, third definition in as many hours —
  // read lib/team/chat-window-threads.ts's file header before touching this
  // again. Antonio, asked directly after the second fix (`ever_opened`, i.e.
  // a genuine non-epoch last_read_at) STILL left the list full: "I don't read
  // them at all unless i have been mentioned. but they are messy because most
  // of them are luca or claude conversation about the clients." Checked before
  // building this: of the ~47 threads `ever_opened` let through, a sample had
  // ZERO messages actually sent by him — a real last_read_at can come from
  // nothing more than once opening a thread to check on it (his own "I have to
  // know everything" habit), which is not what he means by "mine" here.
  // `ever_mentioned` (has an internal_messages row in this thread with him in
  // mentioned_user_ids, since his last "mark done" for it, or ever if he has
  // never dismissed it) is what he actually described. Verified against his
  // real account before shipping: 122 total discussion threads → 1 thread
  // where he has ever been mentioned.
  //
  // 2026-09-05: added the "mark done" dismiss — same-day follow-up, his own
  // words: "I want the option to mark it done and disappear from the list",
  // confirmed it should REAPPEAR on a fresh mention rather than hide forever.
  // So a thread only counts if it has a mention NEWER than the caller's own
  // dismissal timestamp for it (POST .../dismiss-mention) — see
  // internal_thread_mention_dismissals and its migration file for why this is
  // its own table rather than a reuse of internal_thread_reads/_later.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const discussionIds = enriched.filter((t: any) => t.thread_type === 'discussion').map((t: any) => t.id)
  const everMentionedSet = new Set<string>()
  if (discussionIds.length > 0) {
    try {
      const [mentionResult, dismissResult] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabaseAdmin as any)
          .from('internal_messages')
          .select('thread_id, created_at')
          .in('thread_id', discussionIds)
          .is('deleted_at', null)
          .contains('mentioned_user_ids', [user.id]),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabaseAdmin as any)
          .from('internal_thread_mention_dismissals')
          .select('thread_id, dismissed_at')
          .in('thread_id', discussionIds)
          .eq('user_id', user.id),
      ])
      // A Postgrest-level failure returns {data:null,error} rather than
      // throwing — log it (bug-hunter, 2026-09-05) so a real failure here
      // doesn't read identically to "correctly empty," which is this list's
      // own intended common case and would otherwise hide a broken query.
      if (mentionResult.error) console.error('team/threads: ever_mentioned lookup failed', mentionResult.error)
      if (dismissResult.error) console.error('team/threads: mention-dismissal lookup failed', dismissResult.error)
      // Bug-hunter, 2026-09-05: do NOT compute from a partial result. If only
      // the mention query fails, mentions=[] already fails closed (nothing
      // shows — safe). But if only the DISMISSAL query fails, dismissals=[]
      // means "nobody has ever dismissed anything," which makes every mention
      // ever made look undismissed — flooding back every conversation Antonio
      // already cleared, reproducing today's exact "noise" complaint via a
      // transient Supabase hiccup instead of a bad filter. Only compute when
      // BOTH queries actually succeeded; otherwise leave everMentionedSet
      // empty this request, matching the same "never wrong in the unsafe
      // direction" rule already applied to a total lookup failure below.
      if (!mentionResult.error && !dismissResult.error) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mentions = (mentionResult.data ?? []).map((r: any) => ({ threadId: r?.thread_id, createdAt: r?.created_at }))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dismissals = (dismissResult.data ?? []).map((r: any) => ({ threadId: r?.thread_id, dismissedAt: r?.dismissed_at }))
        for (const id of Array.from(everMentionedThreadIds(mentions, dismissals))) everMentionedSet.add(id)
      }
    } catch (e) {
      // Best-effort, like Later and the turn receipts above: a lookup failure
      // here must not empty the whole sidebar. Worst case, ever_mentioned
      // stays false everywhere and the floating chat's list is emptier than
      // it should be for one request — never wrong in the unsafe direction.
      console.error('team/threads: ever_mentioned lookup threw', e)
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const t of enriched as any[]) t.ever_mentioned = t.thread_type === 'discussion' ? everMentionedSet.has(t.id) : null

  const members = await listTeamMembers()

  return NextResponse.json({
    threads: enriched,
    members,
    current_user_id: user.id,
    current_user_name: getUserDisplayName(user),
    is_admin: isAdmin(user),
  })
}
