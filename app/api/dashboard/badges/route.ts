import { createClient } from '@supabase/supabase-js'
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
    // Run all queries in parallel
    const [portalResult, internalResult, gmailSupportResult, gmailAntonioResult, tasksResult, overdueResult] = await Promise.allSettled([
      // Portal chats: count unread client messages using select('id') instead of head:true
      getDb()
        .from('portal_messages')
        .select('id')
        .eq('sender_type', 'client')
        .is('read_at', null)
        .limit(500),
      // Internal team messages: count unread from other team members
      getDb()
        .from('internal_messages')
        .select('id')
        .is('read_at', null)
        .limit(500),
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
    ])

    // Portal chats count (client messages + internal team messages)
    let portalClientCount = 0
    if (portalResult.status === 'fulfilled') {
      if (portalResult.value.error) {
        console.error('[badges] portal_messages error:', JSON.stringify(portalResult.value.error))
      } else {
        portalClientCount = portalResult.value.data?.length ?? 0
      }
    }

    let internalCount = 0
    if (internalResult.status === 'fulfilled') {
      if (!internalResult.value.error) {
        internalCount = internalResult.value.data?.length ?? 0
      }
    }

    const portalChats = portalClientCount + internalCount

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

    return NextResponse.json({ portalChats, inbox, tasks, overdueInvoices, _debug: { supportUnread, antonioUnread } })
  } catch (err) {
    console.error('[dashboard/badges] Error:', err)
    return NextResponse.json({ portalChats: 0, inbox: 0, tasks: 0, overdueInvoices: 0 })
  }
}
