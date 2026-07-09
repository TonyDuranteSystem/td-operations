/**
 * Team Workspace — post a message AS CLAUDE (server-only).
 *
 * Single choke-point for the AI assistant (Claude Code via MCP, and the AI
 * agent worker) to post into the internal Team Chat. Mirrors the human send
 * route (`POST /api/team/threads/[id]/messages`) but:
 *   - the sender is always the CLAUDE sentinel identity (same one that answers
 *     @claude), never a session user;
 *   - it NEVER fires the @claude worker trigger (Claude posting must not invoke
 *     Claude — loop safety);
 *   - it advances no human read pointer (so recipients' unread badges are
 *     correct).
 * It reuses the existing building blocks (findOrCreateDm, resolveMentions, the
 * push helpers, validateTeamCard) so it cannot drift from the real chat.
 *
 * Target is EXACTLY ONE of: a channel (slug or name / "general"), an explicit
 * thread id, or a DM to a staff user. @mentions in the body drive targeted push
 * (e.g. "@Luca ...").
 *
 * The pure input validators are exported for unit tests; `postTeamMessage` does
 * the I/O.
 */
import 'server-only'
import { supabaseAdmin } from '@/lib/supabase-admin'
import {
  CLAUDE_SENDER_UUID,
  CLAUDE_SENDER_NAME,
} from '@/lib/team/workspace'
import { resolveMentions } from '@/lib/team/directory'
import { findOrCreateDm } from '@/lib/team/dm'
import { sendPushToAdminUsers, sendPushToAdminExcluding } from '@/lib/portal/web-push'
import { validateTeamPostTarget, validateTeamPostMessage } from '@/lib/team/post-message-validate'

export { validateTeamPostTarget, validateTeamPostMessage, TEAM_MESSAGE_MAX } from '@/lib/team/post-message-validate'

export interface PostTeamMessageInput {
  /** Channel slug or name (or "general" for the general room). */
  channel?: string | null
  /** Explicit internal_threads id. */
  thread_id?: string | null
  /** Post a DM (as Claude) to this staff user id. */
  dm_user_id?: string | null
  /** Message body. @mentions (e.g. "@Luca") drive targeted push. */
  message: string
  /** Optional rich card (validated via validateTeamCard). */
  card?: unknown
}

export interface PostTeamMessageResult {
  thread_id: string
  message_id: string
  thread_type: string
  mentioned_user_ids: string[]
}

/**
 * Resolve the target selector to a thread id + type. Returns null if not found.
 */
async function resolveTargetThread(
  input: Pick<PostTeamMessageInput, 'channel' | 'thread_id' | 'dm_user_id'>,
): Promise<{ thread_id: string; thread_type: string } | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = supabaseAdmin as any

  if (input.thread_id) {
    const { data } = await admin.from('internal_threads').select('id, thread_type').eq('id', input.thread_id).maybeSingle()
    return data ? { thread_id: data.id, thread_type: data.thread_type } : null
  }

  if (input.dm_user_id) {
    const { thread } = await findOrCreateDm(CLAUDE_SENDER_UUID, input.dm_user_id)
    return { thread_id: thread.id, thread_type: 'dm' }
  }

  // channel: slug first, then name, then the special "general" room.
  const channel = (input.channel ?? '').trim()
  const bySlug = await admin.from('internal_threads').select('id, thread_type').eq('thread_type', 'channel').eq('channel_slug', channel).maybeSingle()
  if (bySlug.data) return { thread_id: bySlug.data.id, thread_type: bySlug.data.thread_type }
  const byName = await admin.from('internal_threads').select('id, thread_type').eq('thread_type', 'channel').ilike('channel_name', channel).maybeSingle()
  if (byName.data) return { thread_id: byName.data.id, thread_type: byName.data.thread_type }
  if (channel.toLowerCase() === 'general') {
    const gen = await admin.from('internal_threads').select('id, thread_type').eq('thread_type', 'general').limit(1).maybeSingle()
    if (gen.data) return { thread_id: gen.data.id, thread_type: gen.data.thread_type }
  }
  return null
}

/**
 * Post a message into Team Chat as Claude. Throws on a resolvable-but-invalid
 * request (bad target / not found / empty message) so callers can surface a
 * clear error; DB errors also throw.
 */
export async function postTeamMessage(input: PostTeamMessageInput): Promise<PostTeamMessageResult> {
  const targetErr = validateTeamPostTarget(input)
  if (targetErr) throw new Error(targetErr)
  const msgErr = validateTeamPostMessage(input.message, input.card)
  if (msgErr) throw new Error(msgErr)

  const target = await resolveTargetThread(input)
  if (!target) throw new Error('Target thread not found (check the channel slug/name, thread id, or user id).')

  const message = input.message.trim()
  const mentions = await resolveMentions(message, CLAUDE_SENDER_UUID)
  const now = new Date().toISOString()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = supabaseAdmin as any
  const { data: msg, error } = await admin
    .from('internal_messages')
    .insert({
      thread_id: target.thread_id,
      sender_id: CLAUDE_SENDER_UUID,
      sender_name: CLAUDE_SENDER_NAME,
      message,
      card: input.card ?? null,
      mentions: mentions.matchedHandles.length ? mentions.matchedHandles : [],
      mentioned_user_ids: mentions.userIds,
      read_at: now,
    })
    .select()
    .single()
  if (error) throw new Error(error.message)

  // Bump activity so the sidebar re-sorts. (No human read pointer is advanced —
  // Claude is not a real user, and advancing a human's pointer would wrongly
  // clear their unread.)
  await admin.from('internal_threads').update({ last_activity_at: now }).eq('id', target.thread_id)

  // Push (best-effort). Targeted to @mentioned staff; else broadcast to all
  // staff (Claude is not a real user, so nobody is excluded).
  try {
    const preview = message.slice(0, 120) || (input.card ? '📇 Shared a card' : 'New message')
    if (mentions.userIds.length > 0) {
      await sendPushToAdminUsers(mentions.userIds, {
        title: `${CLAUDE_SENDER_NAME} mentioned you`,
        body: preview,
        url: `/team-chat?thread=${target.thread_id}`,
        tag: `team-mention-${target.thread_id}`,
      })
    } else {
      await sendPushToAdminExcluding(CLAUDE_SENDER_UUID, {
        title: CLAUDE_SENDER_NAME,
        body: preview,
        url: `/team-chat?thread=${target.thread_id}`,
        tag: `team-thread-${target.thread_id}`,
      })
    }
  } catch {
    // non-critical
  }

  return {
    thread_id: target.thread_id,
    message_id: msg.id as string,
    thread_type: target.thread_type,
    mentioned_user_ids: mentions.userIds,
  }
}
