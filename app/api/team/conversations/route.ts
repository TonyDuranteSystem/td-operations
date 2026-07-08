import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser, getUserDisplayName } from '@/lib/auth'
import { parseClientRef, clientRefColumn, conversationTitle } from '@/lib/team/conversations'
import { channelSlug } from '@/lib/team/workspace'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/team/conversations
 * Start (or reuse) a native client discussion on a topic — the Slack-independent
 * version of the Client-Threads "New conversation" modal. Staff-only.
 * Body: { client: "account:<uuid>"|"contact:<uuid>"|"lead:<uuid>", topic?, channel_id? }
 *   - reuses an OPEN discussion for the same client+topic if one exists
 *   - optionally drops a "new conversation" card into the chosen channel
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const ref = parseClientRef((body.client ?? '').toString())
  if (!ref) return NextResponse.json({ error: 'A valid client is required.' }, { status: 400 })

  const topic: string | null = (body.topic ?? '').toString().trim() || null
  const topicSlug = topic ? channelSlug(topic) || null : null
  const channelId: string | null = (body.channel_id ?? '').toString().trim() || null
  const col = clientRefColumn(ref.kind)

  // Resolve client display name.
  let clientName = 'Client'
  if (ref.kind === 'account') {
    const { data } = await supabaseAdmin.from('accounts').select('company_name').eq('id', ref.id).single()
    if (!data) return NextResponse.json({ error: 'Account not found.' }, { status: 404 })
    clientName = data.company_name ?? clientName
  } else if (ref.kind === 'contact') {
    const { data } = await supabaseAdmin.from('contacts').select('full_name').eq('id', ref.id).single()
    if (!data) return NextResponse.json({ error: 'Contact not found.' }, { status: 404 })
    clientName = data.full_name ?? clientName
  } else {
    const { data } = await supabaseAdmin.from('leads').select('full_name').eq('id', ref.id).single()
    if (!data) return NextResponse.json({ error: 'Lead not found.' }, { status: 404 })
    clientName = data.full_name ?? clientName
  }

  const now = new Date().toISOString()

  // Validate the channel up-front (it's now the thread's HOME, not just a card
  // target) — a bad id should 400, not silently create an unfiled thread.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let channelRow: any = null
  if (channelId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: ch } = await (supabaseAdmin as any)
      .from('internal_threads')
      .select('id, thread_type, color')
      .eq('id', channelId)
      .single()
    if (!ch || (ch.thread_type !== 'channel' && ch.thread_type !== 'general')) {
      return NextResponse.json({ error: 'That channel was not found.' }, { status: 400 })
    }
    channelRow = ch
  }

  // Reuse an OPEN discussion for the same client + topic if present.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let reuseQuery: any = (supabaseAdmin as any)
    .from('internal_threads')
    .select('*')
    .eq('thread_type', 'discussion')
    .eq(col, ref.id)
    .is('resolved_at', null)
    .is('archived_at', null)
  reuseQuery = topicSlug ? reuseQuery.eq('topic_slug', topicSlug) : reuseQuery.is('topic_slug', null)
  const { data: existing } = await reuseQuery.order('created_at', { ascending: false }).limit(1).maybeSingle()

  let thread = existing
  let reused = false
  if (thread) {
    reused = true
    // Reused with a channel selected → file it there (moves an unfiled or
    // differently-filed conversation to the chosen channel, per user intent).
    if (channelId && thread.parent_channel_id !== channelId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabaseAdmin as any)
        .from('internal_threads')
        .update({ parent_channel_id: channelId })
        .eq('id', thread.id)
      thread = { ...thread, parent_channel_id: channelId }
    }
  } else {
    // Slack parity: the channel picked in the modal is WHERE THE CONVERSATION
    // LIVES — file it under that channel folder (parent_channel_id), exactly
    // like Slack's /client modal puts the thread IN the channel. (The card
    // dropped below is the visible "conversation started" marker, mirroring
    // Slack's 🗂️ root message.) Fix for the Tamás Fazekas incident 2026-07-08.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: created, error } = await (supabaseAdmin as any)
      .from('internal_threads')
      .insert({
        thread_type: 'discussion',
        [col]: ref.id,
        topic,
        topic_slug: topicSlug,
        title: conversationTitle(clientName, topic),
        created_by: user.id,
        parent_channel_id: channelId || null,
        last_activity_at: now,
      })
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    thread = created

    // Seed the opening message.
    await supabaseAdmin.from('internal_messages').insert({
      thread_id: thread.id,
      sender_id: user.id,
      sender_name: getUserDisplayName(user),
      message: `🗂️ Conversation started: ${conversationTitle(clientName, topic)}`,
      read_at: now,
    })
  }

  // Drop a "conversation started" card into the channel (the visible marker in
  // the channel timeline — the analog of Slack's 🗂️ root message). Only for
  // NEW conversations; a reuse just re-files silently.
  if (channelRow && !reused) {
    await supabaseAdmin.from('internal_messages').insert({
      thread_id: channelId,
      sender_id: user.id,
      sender_name: getUserDisplayName(user),
      message: '',
      read_at: now,
      card: {
        kind: 'client_message',
        title: `New conversation: ${clientName}`,
        subtitle: topic ? `Topic: ${topic}` : 'Client discussion',
        url: `/team-chat?thread=${thread.id}`,
        color: channelRow.color ?? undefined,
      },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabaseAdmin as any).from('internal_threads').update({ last_activity_at: now }).eq('id', channelId)
  }

  return NextResponse.json({ thread, reused })
}
