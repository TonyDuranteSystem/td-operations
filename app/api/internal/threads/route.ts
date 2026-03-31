import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser, getUserDisplayName } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/internal/threads
 * List all internal team threads with unread counts.
 * Admin-only.
 *
 * POST /api/internal/threads
 * Create a new internal thread linked to a client message.
 * Body: { account_id, source_message_id?, title? }
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const { data: threads, error } = await supabaseAdmin
    .from('internal_threads')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Enrich with company names, unread counts, source message text
  const enriched = await Promise.all((threads ?? []).map(async (thread) => {
    // Company name
    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('company_name')
      .eq('id', thread.account_id)
      .single()

    // Unread count (messages not sent by current user and not read)
    const { count: unreadCount } = await supabaseAdmin
      .from('internal_messages')
      .select('id', { count: 'exact', head: true })
      .eq('thread_id', thread.id)
      .neq('sender_id', user.id)
      .is('read_at', null)

    // Last message
    const { data: lastMsg } = await supabaseAdmin
      .from('internal_messages')
      .select('created_at, message')
      .eq('thread_id', thread.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    // Source message text
    let sourceMessage: string | null = null
    if (thread.source_message_id) {
      const { data: srcMsg } = await supabaseAdmin
        .from('portal_messages')
        .select('message')
        .eq('id', thread.source_message_id)
        .single()
      sourceMessage = srcMsg?.message ?? null
    }

    return {
      ...thread,
      company_name: account?.company_name ?? 'Unknown',
      unread_count: unreadCount ?? 0,
      last_message_at: lastMsg?.created_at ?? thread.created_at,
      last_message_preview: lastMsg?.message?.slice(0, 80) ?? null,
      source_message: sourceMessage,
    }
  }))

  // Sort by last_message_at descending
  enriched.sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime())

  return NextResponse.json({ threads: enriched })
}

export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const body = await request.json()
  const { account_id, source_message_id, title } = body

  if (!account_id) {
    return NextResponse.json({ error: 'account_id is required' }, { status: 400 })
  }

  // Create thread
  const { data: thread, error } = await supabaseAdmin
    .from('internal_threads')
    .insert({
      account_id,
      source_message_id: source_message_id || null,
      created_by: user.id,
      title: title || null,
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Auto-create first message from creator with the source message context
  const displayName = getUserDisplayName(user)
  let firstMessage = 'Started a discussion about this message.'
  if (source_message_id) {
    const { data: srcMsg } = await supabaseAdmin
      .from('portal_messages')
      .select('message')
      .eq('id', source_message_id)
      .single()
    if (srcMsg?.message) {
      firstMessage = `Flagged for discussion: "${srcMsg.message.slice(0, 200)}"`
    }
  }

  await supabaseAdmin.from('internal_messages').insert({
    thread_id: thread.id,
    sender_id: user.id,
    sender_name: displayName,
    message: firstMessage,
  })

  // Send push notification to other admins
  try {
    const { data: subs } = await supabaseAdmin
      .from('admin_push_subscriptions')
      .select('*')
      .neq('user_id', user.id)

    if (subs?.length) {
      const { sendPushToAdmin } = await import('@/lib/portal/web-push')
      // Get company name for notification
      const { data: account } = await supabaseAdmin
        .from('accounts')
        .select('company_name')
        .eq('id', account_id)
        .single()

      await sendPushToAdmin({
        title: `Team: ${account?.company_name ?? 'Client'}`,
        body: title || firstMessage.slice(0, 100),
        url: `/portal-chats?view=internal`,
        tag: `internal-thread-${thread.id}`,
      })
    }
  } catch {
    // Push notification failure is non-critical
  }

  return NextResponse.json({ thread })
}
