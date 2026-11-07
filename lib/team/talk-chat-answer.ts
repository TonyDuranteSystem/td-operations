/**
 * TD Talk's light "open a chat" answer (`GET /api/team/threads/[id]?view=talk`, dev job cf265457) — see lib/talk/chat-open-scope.ts for why it exists.
 *
 * Same rules as the default answer, in fewer round trips:
 * - access is decided exactly as before (a group is for its members, a direct message for its two people);
 * - the newest messages are read at the same time as the chat row and the group's members (they are thrown away, never returned, if access is refused);
 * - reply previews, the other person's read/delivered marks and the caller's own read pointer then run side by side;
 * - the Threads-panel work only the CRM Team Chat page uses (reply counts, follows, Later, per-thread receipts) is not done — TD Talk does not show it.
 * The read pointer moves only when `markRead` is true (the caller's `?mark_read=0` rule is unchanged).
 */
import { isDmParticipant, isGroupMember } from '@/lib/team/groups-rules'
import { withReplyPreviews } from '@/lib/team/reply-previews'

export interface TalkChatArgs {
  threadId: string
  userId: string
  userName: string
  isAdmin: boolean
  /** How many of the newest messages (1..500). */
  limit: number
  /** False when the caller asked for `?mark_read=0`: read without moving the pointer. */
  markRead: boolean
  /** Said when a direct message is not the caller's. */
  deniedMessage: string
  listGroupMemberIds: (threadId: string) => Promise<string[]>
}

export type TalkChatResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: 403 | 404; body: { error: string } }

/** `client` is the service-role Supabase client (the route's `supabaseAdmin`); injected so the rules can be tested without a database. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function buildTalkChatAnswer(client: any, a: TalkChatArgs): Promise<TalkChatResult> {
  const { threadId, userId, limit } = a

  const [threadRes, messagesRes, groupIds] = await Promise.all([
    client.from('internal_threads').select('*').eq('id', threadId).single(),
    // one extra row only to know whether older messages exist (`has_more`)
    client.from('internal_messages').select('*').eq('thread_id', threadId).order('created_at', { ascending: false }).limit(limit + 1),
    a.listGroupMemberIds(threadId),
  ])
  const thread = threadRes?.data
  if (!thread) return { status: 404, body: { error: 'Thread not found' } }

  // A GROUP is private to its members; a DIRECT MESSAGE to its two people (the id comes from the browser and this reads with the service role).
  const groupMembers: string[] | null = thread.thread_type === 'group' ? groupIds : null
  if (groupMembers && !isGroupMember(groupMembers, userId)) return { status: 403, body: { error: 'You are not in this group.' } }
  if (thread.thread_type === 'dm' && !isDmParticipant(thread.dm_key, userId)) return { status: 403, body: { error: a.deniedMessage } }

  if (messagesRes?.error) console.error('team/threads/[id] (talk view): messages lookup failed', messagesRes.error)
  const newestFirst = (messagesRes?.data ?? []) as unknown[]
  const hasMore = newestFirst.length > limit
  const messages = newestFirst.slice(0, limit).reverse()

  // Direct message: how far the OTHER person has read / received (the "seen" and grey double ticks).
  const dmKey: string | null = thread.thread_type === 'dm' ? (thread.dm_key ?? null) : null
  const peerId = dmKey ? dmKey.split(':').find(id => id && id !== userId) : null

  const [withPreviews, peerRead, peerDelivered, memberReads, memberDelivered] = await Promise.all([
    withReplyPreviews(messages, client),
    peerId ? client.from('internal_thread_reads').select('last_read_at').eq('thread_id', threadId).eq('user_id', peerId).maybeSingle() : null,
    peerId ? client.from('internal_thread_delivery').select('delivered_at').eq('thread_id', threadId).eq('user_id', peerId).maybeSingle() : null,
    groupMembers ? client.from('internal_thread_reads').select('user_id, last_read_at').eq('thread_id', threadId).in('user_id', groupMembers) : null,
    groupMembers ? client.from('internal_thread_delivery').select('user_id, delivered_at').eq('thread_id', threadId).in('user_id', groupMembers) : null,
    // the caller's own read pointer (per-user unread model) — only when the caller is actually looking at the chat
    a.markRead
      ? client.from('internal_thread_reads').upsert(
          { thread_id: threadId, user_id: userId, last_read_at: new Date().toISOString(), manual_unread: false, updated_at: new Date().toISOString() },
          { onConflict: 'thread_id,user_id' },
        )
      : null,
  ])

  return {
    status: 200,
    body: {
      members: groupMembers,
      member_reads: groupMembers ? (memberReads?.data ?? []) : null,
      member_delivered: groupMembers ? (memberDelivered?.data ?? []) : null,
      peer_read_at: peerRead?.data?.last_read_at ?? null,
      peer_delivered_at: peerDelivered?.data?.delivered_at ?? null,
      messages: withPreviews,
      has_more: hasMore,
      current_user_id: userId,
      current_user_name: a.userName,
      is_admin: a.isAdmin,
    },
  }
}
