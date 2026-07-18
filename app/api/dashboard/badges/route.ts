import { createClient } from '@supabase/supabase-js'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { countTeamNotifications, type TeamThreadCountRow } from '@/lib/team/workspace'
import { gmailGet } from '@/lib/gmail'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// Fresh client per request — avoids stale cached connections from supabaseAdmin singleton
function getDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

/**
 * GET /api/dashboard/badges
 * Returns unread counts for sidebar badges.
 * Portal Chats = unread client messages in portal_messages.
 * Inbox = Gmail unread from BOTH support@ and antonio@ accounts.
 */
export async function GET() {
  try {
    // Who is asking — team-chat unread is PER-USER (a DM/share is "unread" only
    // for its recipient), so we need the caller's id to compute it correctly.
    let userId: string | null = null
    try {
      const { data: { user } } = await createServerClient().auth.getUser()
      userId = user?.id ?? null
    } catch { /* unauthenticated → teamChat stays 0 */ }

    // Run all queries in parallel
    const [portalResult, teamThreadsResult, gmailSupportResult, gmailAntonioResult, tasksResult, overdueResult, reconReviewResult] = await Promise.allSettled([
      // Portal chats: count unread client messages using select('id') instead of head:true
      getDb()
        .from('portal_messages')
        .select('id')
        .eq('sender_type', 'client')
        .is('read_at', null)
        .limit(500),
      // Internal team chat: per-user unread via get_team_threads (the real
      // read model — internal_thread_reads). The old `read_at IS NULL` count was
      // always 0 because every message is inserted with read_at=now().
      userId
        ? getDb().rpc('get_team_threads', { p_user_id: userId })
        : Promise.resolve({ data: [], error: null }),
      // Gmail: support@ unread
      gmailGet('/labels/INBOX', {}, 'support@tonydurante.us') as Promise<{ messagesUnread?: number }>,
      // Gmail: antonio@ unread
      gmailGet('/labels/INBOX', {}, 'antonio.durante@tonydurante.us') as Promise<{ messagesUnread?: number }>,
      // Tasks: count open tasks
      getDb()
        .from('tasks')
        .select('id')
        .in('status', ['To Do', 'In Progress', 'Waiting'])
        .limit(1000),
      // Overdue invoices for Finance badge
      getDb()
        .from('client_invoices')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'Overdue'),
      // Reconciliation review queue — needs_review + activation_crashed feeds
      getDb()
        .from('td_bank_feeds')
        .select('id', { count: 'exact', head: true })
        .in('status', ['needs_review', 'activation_crashed']),
    ])

    // Portal chats count (client messages only — internal team chat has its own badge)
    let portalClientCount = 0
    if (portalResult.status === 'fulfilled') {
      if (portalResult.value.error) {
        console.error('[badges] portal_messages error:', JSON.stringify(portalResult.value.error))
      } else {
        portalClientCount = portalResult.value.data?.length ?? 0
      }
    }

    const portalChats = portalClientCount

    // Team chat signal — ONLY unread DMs + @mentions (not channel chatter).
    let teamChat = 0
    if (teamThreadsResult.status === 'fulfilled' && !teamThreadsResult.value.error) {
      teamChat = countTeamNotifications((teamThreadsResult.value.data ?? []) as TeamThreadCountRow[])
    }
    // Slack-thread signal: threads this user FOLLOWS with unread replies. Its own
    // count path (follow + unread live at the root-message grain, which
    // get_team_threads doesn't carry). The sidebar renders teamChat > 0 as a DOT,
    // so adding here lights it without reconciling counts across the two grains.
    // Best-effort: never let this break the badges payload.
    if (userId) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: followed } = await (getDb() as any).rpc('list_followed_unread_threads', { p_user_id: userId })
        teamChat += (followed ?? []).length
      } catch { /* non-critical */ }
    }

    // Gmail unread
    const supportUnread = gmailSupportResult.status === 'fulfilled'
      ? (gmailSupportResult.value.messagesUnread ?? 0)
      : 0
    const antonioUnread = gmailAntonioResult.status === 'fulfilled'
      ? (gmailAntonioResult.value.messagesUnread ?? 0)
      : 0
    const inbox = supportUnread + antonioUnread

    // Tasks count
    let tasks = 0
    if (tasksResult.status === 'fulfilled') {
      tasks = tasksResult.value.data?.length ?? 0
    }

    // Overdue invoices count
    let overdueInvoices = 0
    if (overdueResult.status === 'fulfilled' && !overdueResult.value.error) {
      overdueInvoices = overdueResult.value.count ?? 0
    }

    // Reconciliation review queue (needs_review + activation_crashed)
    let reconciliationReview = 0
    if (reconReviewResult.status === 'fulfilled' && !reconReviewResult.value.error) {
      reconciliationReview = reconReviewResult.value.count ?? 0
    }

    // Dev Board notification — brand-new cards created since this user last
    // opened /dev-board. First-time users (no read row) see 0, not the backlog.
    let devBoard = 0
    if (userId) {
      // dev_tasks / dev_board_reads aren't in the generated types.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = getDb() as any
      const { data: readRow } = await db
        .from('dev_board_reads')
        .select('last_seen_at')
        .eq('user_id', userId)
        .maybeSingle()
      const since: string = readRow?.last_seen_at ?? new Date().toISOString()
      const { data: newCards } = await db
        .from('dev_tasks')
        .select('id')
        .neq('status', 'cancelled')
        .gt('created_at', since)
        .limit(500)
      devBoard = Array.isArray(newCards) ? newCards.length : 0
    }

    return NextResponse.json({ portalChats, teamChat, inbox, tasks, overdueInvoices, reconciliationReview, devBoard, _debug: { supportUnread, antonioUnread } })
  } catch (err) {
    console.error('[dashboard/badges] Error:', err)
    return NextResponse.json({ portalChats: 0, inbox: 0, tasks: 0, overdueInvoices: 0, reconciliationReview: 0 })
  }
}
