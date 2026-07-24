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

  // Individual THREADS (bugs) that are new for the caller, across every channel —
  // deep-linked straight to that bug's pane, which is the actionable row.
  //
  // ⚠️ THESE REPLACE the per-channel summary rows built above, they do not sit
  // next to them: a channel's unread_count is now the COUNT OF THESE THREADS,
  // so listing both showed the same bug twice (once named, once inside "#td-bug
  // · 3"). Any channel represented here has its summary row removed below.
  //
  // Previously this listed only threads the caller FOLLOWS. With two people and
  // every channel post notifying, "followed" no longer describes what is new:
  // Luca opened 13 bug threads in td-bug and Antonio follows exactly one of
  // them, so the followed-only list showed almost nothing.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: allThreads } = await (supabaseAdmin as any)
      .rpc('list_all_threads', { p_user_id: user.id, p_limit: 300, p_include_archived: false })
    // Only threads that live in a CHANNEL. list_all_threads also returns the
    // general room's roots, and general is deliberately mention-only in
    // countTeamNotifications (its raw unread can never be cleared) — listing
    // them here would show rows the dot never counted. A badge and the list it
    // opens must describe the same set.
    const channelThreadIds = new Set(
      ((threads ?? []) as TeamNotifThreadRow[])
        .filter(t => t.thread_type === 'channel')
        .map(t => t.id),
    )
    const coveredChannels = new Set<string>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const t of ((allThreads ?? []) as any[])) {
      if (!t?.unread) continue
      if (!channelThreadIds.has(t.thread_id)) continue
      coveredChannels.add(t.thread_id)
      items.push({
        id: t.root_message_id,
        kind: 'thread',
        label: `#${t.channel_label} · ${String(t.title ?? '').slice(0, 60)}`,
        count: 1,
        url: `/team-chat?thread=${t.thread_id}&root=${t.root_message_id}`,
      })
    }
    if (coveredChannels.size > 0) {
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].kind === 'channel' && coveredChannels.has(items[i].id)) items.splice(i, 1)
      }
    }
  } catch {
    // Best-effort: on failure the per-channel summary rows survive, so the list
    // still says WHERE something is new — never nothing.
  }

  return NextResponse.json({ items })
}
