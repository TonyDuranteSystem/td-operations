import { createClient } from '@supabase/supabase-js'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { countTeamNotifications, countTalkNotifications, type TeamThreadCountRow } from '@/lib/team/workspace'
import { gmailGet } from '@/lib/gmail'
import { isAdmin, isDashboardUser, isSecureAdmin } from '@/lib/auth'
import { mailboxAllowedFor, PERSONAL_MAILBOX } from '@/lib/inbox/mailbox-access'
import { adminMemberContext } from '@/lib/marketing/guard'
import { marketingChatUnread } from '@/lib/marketing/menu-unread'
import { getWhatsappUnread } from '@/lib/inbox/whatsapp-unread'
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
 * Inbox = Gmail unread (email only) from support@, plus antonio@ ONLY for a login that may open that mailbox (the Inbox's own rule,
 * lib/inbox/mailbox-access.ts) — a team login's red number must match what its Inbox can show (dev job 1e82504b).
 * WhatsApp = unread WhatsApp conversations, its own menu row (never Telegram).
 */
export async function GET(request: Request) {
  // The LIGHT question — `?only=whatsapp`: just the WhatsApp number (one cheap lookup; no Gmail, no other counts). The menu asks this
  // when a chat message arrives, so a burst of messages never costs a full badge check per message per open tab.
  if (new URL(request.url).searchParams.get('only') === 'whatsapp') {
    try {
      const { data: { user } } = await createServerClient().auth.getUser()
      if (!user || !isDashboardUser(user)) return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
    } catch {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
    }
    return NextResponse.json({ whatsapp: await getWhatsappUnread() })
  }

  try {
    // Who is asking — team-chat unread is PER-USER (a DM/share is "unread" only
    // for its recipient), so we need the caller's id to compute it correctly.
    let userId: string | null = null
    let adminUser: { id: string; email?: string | null } | null = null
    // antonio@ is his PERSONAL mailbox: only a login that may OPEN it gets it counted. Fails closed (no login found → not counted).
    let canSeePersonalMail = false
    try {
      const { data: { user } } = await createServerClient().auth.getUser()
      userId = user?.id ?? null
      if (user && isSecureAdmin(user)) adminUser = { id: user.id, email: user.email }
      canSeePersonalMail = mailboxAllowedFor(PERSONAL_MAILBOX, isAdmin(user))
    } catch { /* unauthenticated → teamChat stays 0 */ }

    // WhatsApp's own number — started now, read below.
    const whatsappPromise = getWhatsappUnread()

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
      // Gmail: antonio@ unread — not even asked for a login that cannot open that mailbox (no wasted Gmail call, no count leaked)
      canSeePersonalMail
        ? (gmailGet('/labels/INBOX', {}, 'antonio.durante@tonydurante.us') as Promise<{ messagesUnread?: number }>)
        : Promise.resolve({ messagesUnread: 0 }),
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

    // Team chat signal — unread DMs, participant conversations, @mentions, AND
    // work channels (counted as bugs-with-something-new since 2026-07-24).
    let teamChat = 0
    let talk = 0 // the TD Talk tab's own signal: unread DMs + groups only
    if (teamThreadsResult.status === 'fulfilled' && !teamThreadsResult.value.error) {
      teamChat = countTeamNotifications((teamThreadsResult.value.data ?? []) as TeamThreadCountRow[])
      talk = countTalkNotifications((teamThreadsResult.value.data ?? []) as TeamThreadCountRow[])
    }
    // NOTE (2026-07-24): the followed-unread-threads count used to be ADDED here.
    // It no longer is, and must not be re-added: a channel's unread_count is now
    // itself the number of THREADS in it that are new for you, so every followed
    // unread thread is already inside that number. Adding both counted the same
    // bug twice.

    // Gmail unread
    const supportUnread = gmailSupportResult.status === 'fulfilled'
      ? (gmailSupportResult.value.messagesUnread ?? 0)
      : 0
    const antonioUnread = gmailAntonioResult.status === 'fulfilled'
      ? (gmailAntonioResult.value.messagesUnread ?? 0)
      : 0
    const inbox = supportUnread + antonioUnread
    const whatsapp = await whatsappPromise

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

    // Marketing: what the team waits on him for. Only when he has joined a team as a member (0 otherwise); never allowed to break the other badges.
    let marketing = 0
    if (adminUser) {
      try {
        const g = await adminMemberContext(adminUser)
        if (g.ok) marketing = await marketingChatUnread(g.ctx)
      } catch (e) { console.error('[badges] marketing unread failed:', e instanceof Error ? e.message : e) }
    }

    return NextResponse.json({ portalChats, teamChat, talk, inbox, whatsapp, tasks, overdueInvoices, reconciliationReview, devBoard, marketing, _debug: { supportUnread, antonioUnread } })
  } catch (err) {
    console.error('[dashboard/badges] Error:', err)
    return NextResponse.json({ portalChats: 0, inbox: 0, tasks: 0, overdueInvoices: 0, reconciliationReview: 0 })
  }
}
