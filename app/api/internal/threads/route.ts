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

  // Enrich with company/contact names, unread counts, source message text
  const enriched = await Promise.all((threads ?? []).map(async (thread) => {
    // Company name or contact name
    let accountName: string | null = null
    let contactName: string | null = null

    if (thread.account_id) {
      const { data: account } = await supabaseAdmin
        .from('accounts')
        .select('company_name')
        .eq('id', thread.account_id)
        .single()
      accountName = account?.company_name ?? null
    }

    if (thread.contact_id) {
      const { data: contact } = await supabaseAdmin
        .from('contacts')
        .select('full_name')
        .eq('id', thread.contact_id)
        .single()
      contactName = contact?.full_name ?? null
    }

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
      company_name: accountName ?? contactName ?? thread.title ?? 'Team Thread',
      contact_name: contactName,
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
  const { account_id, contact_id, source_message_id, title } = body

  // Ad-hoc team threads (no client) require a title
  if (!account_id && !contact_id && !title) {
    return NextResponse.json({ error: 'Team threads without a client require a title' }, { status: 400 })
  }

  // Check for existing unresolved thread — reuse it (only for client-linked threads)
  let existingThread = null
  if (account_id || contact_id) {
    let existingQuery = supabaseAdmin
      .from('internal_threads')
      .select('*')
      .is('resolved_at', null)
      .order('created_at', { ascending: false })
      .limit(1)

    if (account_id) {
      existingQuery = existingQuery.eq('account_id', account_id)
    } else {
      existingQuery = existingQuery.eq('contact_id', contact_id)
    }

    const { data } = await existingQuery.single()
    existingThread = data
  }

  if (existingThread) {
    // Add a message to the existing thread instead of creating a new one
    const displayName = getUserDisplayName(user)
    let contextMessage = 'Added to this discussion.'
    if (source_message_id) {
      const { data: srcMsg } = await supabaseAdmin
        .from('portal_messages')
        .select('message')
        .eq('id', source_message_id)
        .single()
      if (srcMsg?.message) {
        contextMessage = `Flagged another message: "${srcMsg.message.slice(0, 200)}"`
      }
    } else if (title) {
      contextMessage = `New discussion topic: ${title}`
    }

    await supabaseAdmin.from('internal_messages').insert({
      thread_id: existingThread.id,
      sender_id: user.id,
      sender_name: displayName,
      message: contextMessage,
    })

    return NextResponse.json({ thread: existingThread, reused: true })
  }

  // Create new thread
  const { data: thread, error } = await supabaseAdmin
    .from('internal_threads')
    .insert({
      account_id: account_id || null,
      contact_id: contact_id || null,
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
      // Get name for notification
      let notifName = title || 'Team'
      if (account_id) {
        const { data: account } = await supabaseAdmin
          .from('accounts')
          .select('company_name')
          .eq('id', account_id)
          .single()
        notifName = account?.company_name ?? 'Team'
      } else if (contact_id) {
        const { data: contact } = await supabaseAdmin
          .from('contacts')
          .select('full_name')
          .eq('id', contact_id)
          .single()
        notifName = contact?.full_name ?? 'Team'
      }

      await sendPushToAdmin({
        title: `Team: ${notifName}`,
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
