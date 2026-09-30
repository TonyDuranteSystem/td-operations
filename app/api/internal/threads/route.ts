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

  try {
    // ONE database request for the whole list (was hundreds per refresh — see lib/internal/thread-list.ts)
    const { listInternalThreads } = await import('@/lib/internal/thread-list')
    return NextResponse.json({ threads: await listInternalThreads(user.id) })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not load the threads' }, { status: 500 })
  }
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
      const { sendPushToStaffExcept } = await import('@/lib/team/notify')
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

      await sendPushToStaffExcept(user.id, {
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
