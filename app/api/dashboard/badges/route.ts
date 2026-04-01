import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/dashboard/badges
 * Returns unread counts for sidebar badges.
 * No auth check — uses supabaseAdmin. Safe because it only returns counts.
 */
export async function GET() {
  try {
    const [portalResult, inboxResult, tasksResult] = await Promise.allSettled([
      // Portal chats: unread client messages
      supabaseAdmin
        .from('portal_messages')
        .select('id', { count: 'exact', head: true })
        .eq('sender_type', 'client')
        .is('read_at', null),
      // Inbox: unread WhatsApp/Telegram from messaging_groups
      supabaseAdmin
        .from('messaging_groups')
        .select('unread_count')
        .eq('is_active', true)
        .gt('unread_count', 0),
      // Tasks: open tasks
      supabaseAdmin
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .in('status', ['To Do', 'In Progress', 'Waiting']),
    ])

    const portalChats = portalResult.status === 'fulfilled'
      ? (portalResult.value.count ?? 0)
      : 0

    let inbox = 0
    if (inboxResult.status === 'fulfilled' && inboxResult.value.data) {
      inbox = inboxResult.value.data.reduce((sum, row) => sum + (row.unread_count || 0), 0)
    }

    const tasks = tasksResult.status === 'fulfilled'
      ? (tasksResult.value.count ?? 0)
      : 0

    return NextResponse.json({ portalChats, inbox, tasks })
  } catch (err) {
    console.error('[dashboard/badges] Error:', err)
    return NextResponse.json({ portalChats: 0, inbox: 0, tasks: 0 })
  }
}
