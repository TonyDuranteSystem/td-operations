import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser, getUserDisplayName } from '@/lib/auth'
import { resolveMentions } from '@/lib/team/directory'
import { sendPushToAdminUsers } from '@/lib/portal/web-push'
import { sendPushToStaffExcept } from '@/lib/team/notify'
import { channelNotifiesStaff } from '@/lib/team/channel-notify'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/team/threads/[id]/new-thread
 * Deliberately START a thread in a channel — the "+ New thread" button — instead
 * of waiting for someone to reply to a message. Body: { title, body? }.
 *
 * Posts ONE opening message (title + optional body — one message, so an @claude
 * in the text can't fire the worker twice), then registers it as a REAL thread:
 *   - internal_thread_state row carrying its own `title` + created_as_thread=true,
 *     so the thread exists in every list immediately (zero replies) and can never
 *     be auto-cleaned by the sparse revert-to-default rule, nor renamed by editing
 *     or deleting the opening message.
 *   - the creator follows it, so replies ping them.
 * @mentions still notify (targeted push, deep-linked to the thread pane), and the
 * channel's activity is bumped — but the @claude worker is deliberately NOT
 * triggered from a title: naming a topic "@claude why is X failing?" must not
 * spawn an unsolicited AI answer as reply #1.
 * Staff-only; channels/general only.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }
  const { id: threadId } = await params
  const body = await request.json().catch(() => ({}))

  const title: string = (body.title ?? '').toString().trim()
  const note: string = (body.body ?? '').toString().trim()
  if (!title) return NextResponse.json({ error: 'A title is required.' }, { status: 400 })
  if (title.length > 200) return NextResponse.json({ error: 'Title too long (max 200 characters).' }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: thread } = await (supabaseAdmin as any)
    .from('internal_threads')
    .select('id, thread_type, channel_slug, channel_name')
    .eq('id', threadId)
    .single()
  if (!thread || (thread.thread_type !== 'channel' && thread.thread_type !== 'general')) {
    return NextResponse.json({ error: 'Threads can only be started in a channel.' }, { status: 400 })
  }

  const messageText = note ? `${title}\n\n${note}` : title
  const mentions = await resolveMentions(messageText, user.id)
  const displayName = getUserDisplayName(user)
  const now = new Date().toISOString()

  // 1. The opening message — a ROOT (root_id stays null).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: msg, error } = await (supabaseAdmin as any)
    .from('internal_messages')
    .insert({
      thread_id: threadId,
      sender_id: user.id,
      sender_name: displayName,
      message: messageText,
      mentions: mentions.matchedHandles.length ? mentions.matchedHandles : [],
      mentioned_user_ids: mentions.userIds,
      read_at: now,
    })
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // 2. Register it as a real thread (own title + durable marker).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: stateErr } = await (supabaseAdmin as any)
    .from('internal_thread_state')
    .upsert(
      { root_message_id: msg.id, thread_id: threadId, status: 'todo', title, created_as_thread: true, updated_at: now, updated_by: user.id },
      { onConflict: 'root_message_id' },
    )
  if (stateErr) return NextResponse.json({ error: stateErr.message }, { status: 500 })

  // 3. The creator follows their own thread (sequenced AFTER the message exists).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from('internal_root_follows')
    .upsert({ root_message_id: msg.id, user_id: user.id }, { onConflict: 'root_message_id,user_id', ignoreDuplicates: true })

  // 4. Housekeeping: channel activity + the creator has read their own post.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any).from('internal_threads').update({ last_activity_at: now }).eq('id', threadId)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from('internal_thread_reads')
    .upsert({ thread_id: threadId, user_id: user.id, last_read_at: now, updated_at: now }, { onConflict: 'thread_id,user_id' })

  // 5. Tell the team. A NEW BUG is the single most important thing that happens
  //    in this channel, and until 2026-07-24 opening one notified nobody unless
  //    you also remembered to @name someone. Every staff member except the
  //    author now gets it, deep-linked straight to the new thread's pane — the
  //    same rule (and the same predicate) as a reply.
  try {
    const channelLabel = thread.channel_slug ?? thread.channel_name ?? 'general'
    if (channelNotifiesStaff(thread.channel_slug ?? thread.channel_name ?? null)) {
      await sendPushToStaffExcept(user.id, {
        title: `${displayName} opened · #${channelLabel}`,
        body: title.slice(0, 120),
        url: `/team-chat?thread=${threadId}&root=${msg.id}`,
        tag: `team-thread-${msg.id}`,
      })
    } else if (mentions.userIds.length > 0) {
      await sendPushToAdminUsers(mentions.userIds, {
        title: `${displayName} started a thread`,
        body: title.slice(0, 120),
        url: `/team-chat?thread=${threadId}&root=${msg.id}`,
        tag: `team-thread-${msg.id}`,
      })
    }
  } catch { /* non-critical */ }

  return NextResponse.json({ message: msg, root_id: msg.id })
}
