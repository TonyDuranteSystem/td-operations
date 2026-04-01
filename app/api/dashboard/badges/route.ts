import { supabaseAdmin } from '@/lib/supabase-admin'
import { gmailGet } from '@/lib/gmail'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/dashboard/badges
 * Returns unread counts for sidebar badges.
 * Portal Chats = unread client messages in portal_messages.
 * Inbox = Gmail unread from BOTH support@ and antonio@ accounts.
 */
export async function GET() {
  try {
    // Run all queries in parallel
    const [portalResult, gmailSupportResult, gmailAntonioResult, tasksResult] = await Promise.allSettled([
      // Portal chats: count unread client messages using select('id') instead of head:true
      supabaseAdmin
        .from('portal_messages')
        .select('id')
        .eq('sender_type', 'client')
        .is('read_at', null)
        .limit(500),
      // Gmail: support@ unread
      gmailGet('/labels/INBOX', {}, 'support@tonydurante.us') as Promise<{ messagesUnread?: number }>,
      // Gmail: antonio@ unread
      gmailGet('/labels/INBOX', {}, 'antonio.durante@tonydurante.us') as Promise<{ messagesUnread?: number }>,
      // Tasks: count open tasks
      supabaseAdmin
        .from('tasks')
        .select('id')
        .in('status', ['To Do', 'In Progress', 'Waiting'])
        .limit(1000),
    ])

    // Portal chats count
    let portalChats = 0
    if (portalResult.status === 'fulfilled') {
      if (portalResult.value.error) {
        console.error('[badges] portal_messages error:', JSON.stringify(portalResult.value.error))
      } else {
        portalChats = portalResult.value.data?.length ?? 0
      }
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

    return NextResponse.json({ portalChats, inbox, tasks, _debug: { supportUnread, antonioUnread } })
  } catch (err) {
    console.error('[dashboard/badges] Error:', err)
    return NextResponse.json({ portalChats: 0, inbox: 0, tasks: 0 })
  }
}
