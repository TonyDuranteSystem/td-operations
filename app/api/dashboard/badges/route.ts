import { supabaseAdmin } from '@/lib/supabase-admin'
import { gmailGet } from '@/lib/gmail'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/dashboard/badges
 * Returns unread counts for sidebar badges.
 * Inbox = Gmail unread only (primary inbox). WhatsApp/Telegram handled separately.
 */
export async function GET() {
  try {
    const [portalResult, gmailResult, tasksResult] = await Promise.allSettled([
      // Portal chats: unread client messages
      supabaseAdmin
        .from('portal_messages')
        .select('id', { count: 'exact', head: true })
        .eq('sender_type', 'client')
        .is('read_at', null),
      // Inbox: Gmail unread count (primary inbox)
      gmailGet('/labels/INBOX') as Promise<{ messagesUnread?: number }>,
      // Tasks: open tasks
      supabaseAdmin
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .in('status', ['To Do', 'In Progress', 'Waiting']),
    ])

    const portalChats = portalResult.status === 'fulfilled'
      ? (portalResult.value.count ?? 0)
      : 0

    const inbox = gmailResult.status === 'fulfilled'
      ? (gmailResult.value.messagesUnread ?? 0)
      : 0

    const tasks = tasksResult.status === 'fulfilled'
      ? (tasksResult.value.count ?? 0)
      : 0

    return NextResponse.json({ portalChats, inbox, tasks })
  } catch (err) {
    console.error('[dashboard/badges] Error:', err)
    return NextResponse.json({ portalChats: 0, inbox: 0, tasks: 0 })
  }
}
