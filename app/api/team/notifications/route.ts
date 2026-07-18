import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { listTeamMembers } from '@/lib/team/directory'
import { buildTeamNotifications, type TeamNotifThreadRow } from '@/lib/team/workspace'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * GET /api/team/notifications
 * The list behind the sidebar Team Chat dot: the caller's unread DMs + @mentions,
 * each labelled (other person / channel) and deep-linked. Same scope as the dot
 * (no plain channel unread). Staff-only, strictly per-user (get_team_threads).
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

  const members = await listTeamMembers()
  const nameById = new Map(members.map(m => [m.id, m.name]))
  const items = buildTeamNotifications(
    (threads ?? []) as TeamNotifThreadRow[],
    user.id,
    (id) => nameById.get(id),
  )

  // Slack threads the caller FOLLOWS that have unread replies — same signal that
  // lights the dot, so clicking it always shows what caused it. Deep-links
  // straight to that thread's pane. Best-effort: never break the list.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: followed } = await (supabaseAdmin as any)
      .rpc('list_followed_unread_threads', { p_user_id: user.id })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const f of ((followed ?? []) as any[])) {
      items.push({
        id: f.root_message_id,
        kind: 'thread',
        label: `#${f.thread_label} · ${String(f.title ?? '').slice(0, 60)}`,
        count: Number(f.unread_count) || 1,
        url: `/team-chat?thread=${f.thread_id}&root=${f.root_message_id}`,
      })
    }
  } catch { /* non-critical */ }

  return NextResponse.json({ items })
}
