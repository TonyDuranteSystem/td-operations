import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser, isAdmin, getUserDisplayName } from '@/lib/auth'
import { listTeamMembers } from '@/lib/team/directory'
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

  const members = await listTeamMembers()

  return NextResponse.json({
    threads: enriched,
    members,
    current_user_id: user.id,
    current_user_name: getUserDisplayName(user),
    is_admin: isAdmin(user),
  })
}
