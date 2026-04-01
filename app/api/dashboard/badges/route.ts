import { supabaseAdmin } from '@/lib/supabase-admin'
import { gmailGet } from '@/lib/gmail'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/dashboard/badges
 * Returns unread counts for sidebar badges.
 * Inbox = Gmail unread from BOTH support@ and antonio@ accounts.
 */
export async function GET() {
  try {
    const [portalResult, gmailSupportResult, gmailAntonioResult, tasksResult] = await Promise.allSettled([
      // Portal chats: unread client messages
      supabaseAdmin
        .from('portal_messages')
        .select('id', { count: 'exact', head: true })
        .eq('sender_type', 'client')
        .is('read_at', null),
      // Gmail: support@ unread
      gmailGet('/labels/INBOX', {}, 'support@tonydurante.us') as Promise<{ messagesUnread?: number }>,
      // Gmail: antonio@ unread
      gmailGet('/labels/INBOX', {}, 'antonio.durante@tonydurante.us') as Promise<{ messagesUnread?: number }>,
      // Tasks: open tasks
      supabaseAdmin
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .in('status', ['To Do', 'In Progress', 'Waiting']),
    ])

    const portalChats = portalResult.status === 'fulfilled'
      ? (portalResult.value.count ?? 0)
      : 0

    const supportUnread = gmailSupportResult.status === 'fulfilled'
      ? (gmailSupportResult.value.messagesUnread ?? 0)
      : 0

    const antonioUnread = gmailAntonioResult.status === 'fulfilled'
      ? (gmailAntonioResult.value.messagesUnread ?? 0)
      : 0

    const inbox = supportUnread + antonioUnread

    const tasks = tasksResult.status === 'fulfilled'
      ? (tasksResult.value.count ?? 0)
      : 0

    return NextResponse.json({ portalChats, inbox, tasks, _debug: { supportUnread, antonioUnread } })
  } catch (err) {
    console.error('[dashboard/badges] Error:', err)
    return NextResponse.json({ portalChats: 0, inbox: 0, tasks: 0 })
  }
}
