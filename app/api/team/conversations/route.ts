import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser, getUserDisplayName } from '@/lib/auth'
import { parseClientRef } from '@/lib/team/conversations'
import { findOrCreateConversation } from '@/lib/team/find-conversation'
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
  const channelId: string | null = (body.channel_id ?? '').toString().trim() || null

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

  // Find-or-create through the SHARED helper — never a second predicate.
  //
  // This route used to hand-roll its own reuse query keyed on `resolved_at IS
  // NULL`. That is exactly the predicate find-conversation.ts documents as
  // WRONG: it forks a duplicate the moment a conversation is marked Solved, so
  // starting a chat about a solved client+topic created a SECOND live thread
  // while Share reused and reopened the first — messages split across two
  // conversations with identical labels, invisibly. The helper's header says
  // in as many words "do not add a third"; this was the third. (2026-07-23)
  //
  // `forceNew` is the caller's escape hatch when they genuinely want a separate
  // conversation rather than continuing the open one.
  const found = await findOrCreateConversation({
    ref,
    topic,
    createdBy: user.id,
    createdByName: getUserDisplayName(user),
    forceNew: body.force_new === true,
  })
  // The helper reports a missing client / DB failure rather than throwing —
  // surface it verbatim so the caller sees the real reason (R099).
  if ('error' in found) {
    return NextResponse.json({ error: found.error }, { status: found.status })
  }
  let thread = found.thread
  const reused = found.reused
  const clientName = found.clientName

  // Filing: the channel picked in the modal is WHERE THE CONVERSATION LIVES,
  // exactly like Slack's /client modal puts the thread IN the channel. Applies
  // to a reused conversation too — moving an unfiled or differently-filed one
  // to the chosen channel is the user's intent. (Tamás Fazekas incident,
  // 2026-07-08.)
  if (channelId && thread.parent_channel_id !== channelId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabaseAdmin as any)
      .from('internal_threads')
      .update({ parent_channel_id: channelId })
      .eq('id', thread.id)
    thread = { ...thread, parent_channel_id: channelId }
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
