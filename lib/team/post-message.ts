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
import { resolveMentions, listTeamMembers } from '@/lib/team/directory'
import { findOrCreateDm } from '@/lib/team/dm'
import { sendPushToAdminUsers } from '@/lib/portal/web-push'
import { sendPushToStaffExcept } from '@/lib/team/notify'
import { channelNotifiesStaff } from '@/lib/team/channel-notify'
import { validateTeamPostTarget, validateTeamPostMessage } from '@/lib/team/post-message-validate'
import { resolveActingUser } from '@/lib/team/acting-user'

export { validateTeamPostTarget, validateTeamPostMessage, TEAM_MESSAGE_MAX } from '@/lib/team/post-message-validate'

export interface PostTeamMessageInput {
  /** Channel slug or name (or "general" for the general room). */
  channel?: string | null
  /** Explicit internal_threads id. */
  thread_id?: string | null
  /** Post a DM (as Claude) to this staff user id. */
  dm_user_id?: string | null
  /**
   * Answer INSIDE an existing thread (a bug) rather than posting a new
   * top-level message. The root message id of that thread — validated to belong
   * to the resolved target. Combine with `channel` or `thread_id`.
   */
  root_id?: string | null
  /** Message body. @mentions (e.g. "@Luca") drive targeted push. */
  message: string
  /** Optional rich card (validated via validateTeamCard). */
  card?: unknown
  /**
   * The STAFF user (auth uuid or email) who dictated this message, when the
   * calling surface knows it for certain. Stamped on the row so that person is
   * excluded from push/toast and their unread counters — as if they had typed
   * it themselves. COUNCIL RULE (2026-07-29): on any ambiguity pass nothing —
   * an unknown actor stamps null and EVERYONE is notified (today's behavior).
   * Never guess: a wrong id silences the wrong person's notifications.
   */
  on_behalf_of?: string | null
}

export interface PostTeamMessageResult {
  thread_id: string
  message_id: string
  thread_type: string
  mentioned_user_ids: string[]
  /** The thread this answer landed inside, or null for a top-level post. */
  root_id: string | null
}

/**
 * Resolve the target selector to a thread id + type. Returns null if not found.
 */
async function resolveTargetThread(
  input: Pick<PostTeamMessageInput, 'channel' | 'thread_id' | 'dm_user_id'>,
): Promise<{ thread_id: string; thread_type: string; channel_slug: string | null; channel_name: string | null; dm_key: string | null } | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = supabaseAdmin as any

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shape = (d: any) => ({
    thread_id: d.id as string,
    thread_type: d.thread_type as string,
    channel_slug: (d.channel_slug ?? null) as string | null,
    channel_name: (d.channel_name ?? null) as string | null,
    dm_key: (d.dm_key ?? null) as string | null,
  })
  const COLS = 'id, thread_type, channel_slug, channel_name, dm_key'

  if (input.thread_id) {
    const { data } = await admin.from('internal_threads').select(COLS).eq('id', input.thread_id).maybeSingle()
    return data ? shape(data) : null
  }

  if (input.dm_user_id) {
    const { thread } = await findOrCreateDm(CLAUDE_SENDER_UUID, input.dm_user_id)
    return { thread_id: thread.id, thread_type: 'dm', channel_slug: null, channel_name: null, dm_key: thread.dm_key ?? null }
  }

  // channel: slug first, then name, then the special "general" room.
  const channel = (input.channel ?? '').trim()
  const bySlug = await admin.from('internal_threads').select(COLS).eq('thread_type', 'channel').eq('channel_slug', channel).maybeSingle()
  if (bySlug.data) return shape(bySlug.data)
  const byName = await admin.from('internal_threads').select(COLS).eq('thread_type', 'channel').ilike('channel_name', channel).maybeSingle()
  if (byName.data) return shape(byName.data)
  if (channel.toLowerCase() === 'general') {
    const gen = await admin.from('internal_threads').select(COLS).eq('thread_type', 'general').limit(1).maybeSingle()
    if (gen.data) return shape(gen.data)
  }
  return null
}

/**
 * Unknown-column insert error (PostgREST schema-cache miss PGRST204, or raw
 * Postgres 42703). Scoped tightly so the deploy-before-DDL retry below can
 * never swallow a real insert failure.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isUnknownColumnError(error: any): boolean {
  const code = String(error?.code ?? '')
  if (code === 'PGRST204' || code === '42703') return true
  return /on_behalf_of_user_id.*(column|schema cache)/i.test(String(error?.message ?? ''))
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = supabaseAdmin as any

  // ── Answering INSIDE a specific thread (a bug), not into the channel ──────
  // Antonio 2026-07-24: from a coding session he says "tell Luca X" about the
  // bug he is working on. Without this the answer landed as a NEW top-level
  // message in the stream, detached from the bug it belongs to — and Luca's
  // notification opened the channel rather than the bug.
  // The root is validated against the resolved thread, so a wrong id cannot
  // graft an answer onto an unrelated bug (or another channel's).
  let rootId: string | null = null
  if (input.root_id) {
    // Threads exist ONLY in channels/general. A thread_id pointing at a DM or a
    // client discussion would otherwise accept a root_id and stamp a message
    // that renders in the flat stream but is invisible to every thread list.
    if (target.thread_type !== 'channel' && target.thread_type !== 'general') {
      throw new Error('root_id is only valid in a channel — that target has no threads inside it.')
    }
    const { data: root } = await admin
      .from('internal_messages')
      .select('id, thread_id, root_id')
      .eq('id', input.root_id)
      .maybeSingle()
    if (!root) throw new Error('root_id not found.')
    if (root.thread_id !== target.thread_id) {
      throw new Error('root_id belongs to a different channel than the target.')
    }
    // Replying to a reply flattens to its root — the same 2-level rule the
    // human send route applies, so a thread can never grow a third level.
    rootId = (root.root_id ?? root.id) as string
  }

  // ── Acting user ("on behalf of") ──────────────────────────────────────────
  // Resolve the dictating staff member against the directory. Best-effort and
  // fail-to-null: an unresolvable/foreign id must degrade to "notify everyone"
  // (today's behavior), never block the send and never guess (council rule).
  let actingUserId: string | null = null
  if (input.on_behalf_of) {
    try {
      actingUserId = resolveActingUser(await listTeamMembers(), input.on_behalf_of)
    } catch {
      actingUserId = null
    }
  }

  const message = input.message.trim()
  // Excluding the ACTING user from mention resolution gives typed-message
  // parity: resolveMentions never includes the sender, and for a dictated
  // message the sender-in-spirit is the acting user. A self-mention therefore
  // neither stores nor pushes — and an emptied mention list falls through to
  // the channel broadcast below, so Luca is never silenced by Antonio
  // @mentioning himself (senior-engineer finding, 2026-07-29).
  const mentions = await resolveMentions(message, actingUserId ?? CLAUDE_SENDER_UUID)
  const now = new Date().toISOString()

  const baseRow = {
    thread_id: target.thread_id,
    sender_id: CLAUDE_SENDER_UUID,
    sender_name: CLAUDE_SENDER_NAME,
    message,
    root_id: rootId,
    reply_to_id: rootId,
    card: input.card ?? null,
    mentions: mentions.matchedHandles.length ? mentions.matchedHandles : [],
    mentioned_user_ids: mentions.userIds,
    read_at: now,
  }
  let insertRes = await admin
    .from('internal_messages')
    .insert(actingUserId ? { ...baseRow, on_behalf_of_user_id: actingUserId } : baseRow)
    .select()
    .single()
  if (insertRes.error && actingUserId && isUnknownColumnError(insertRes.error)) {
    // Deploy-before-DDL window: prod code can land before Antonio runs the
    // migration in the SQL editor. The message must still send — only the
    // stamping degrades (push exclusion below still works in-memory).
    console.warn('[post-message] on_behalf_of_user_id column missing — retrying insert without it. Run migration 20260729-1900.')
    insertRes = await admin.from('internal_messages').insert(baseRow).select().single()
  }
  const { data: msg, error } = insertRes
  if (error) throw new Error(error.message)

  // Auto-follow for the acting user: replying into a thread follows it, same
  // as the human route — otherwise a dictated reply into the one SILENT
  // channel (td-worker-bug) would leave them off the followers push list and
  // the menu dot for that thread's future replies. Never touches read state.
  if (rootId && actingUserId) {
    try {
      await admin
        .from('internal_root_follows')
        .upsert({ root_message_id: rootId, user_id: actingUserId }, { onConflict: 'root_message_id,user_id', ignoreDuplicates: true })
    } catch { /* best-effort */ }
  }

  // An answer into an ARCHIVED thread brings it back — same rule as the human
  // send route. Without it the message is accepted and pushed, yet the thread
  // stays hidden from the channel, the panel and the board.
  if (rootId) {
    try {
      await admin
        .from('internal_thread_state')
        .update({ archived_at: null, archived_by: null, updated_at: now })
        .eq('root_message_id', rootId)
        .not('archived_at', 'is', null)
    } catch { /* an un-archive failure must not fail the post */ }
  }

  // Bump activity so the sidebar re-sorts. (No human read pointer is advanced —
  // Claude is not a real user, and advancing a human's pointer would wrongly
  // clear their unread.)
  await admin.from('internal_threads').update({ last_activity_at: now }).eq('id', target.thread_id)

  // Push (best-effort) — to STAFF, resolved by name. Never the old "everyone
  // with a registered device" broadcast (see lib/team/notify.ts). Claude is not
  // a real user; the ACTING user (who dictated this message) is excluded from
  // every branch exactly as if they had typed it themselves.
  try {
    const preview = message.slice(0, 120) || (input.card ? '📇 Shared a card' : 'New message')
    const url = `/team-chat?thread=${target.thread_id}${rootId ? `&root=${rootId}` : ''}`
    // Per-thread tag so two bugs don't replace each other on the lock screen.
    const tag = rootId ? `team-thread-${rootId}` : `team-thread-${target.thread_id}`
    // mentions already exclude the acting user (resolveMentions sender param).
    if (mentions.userIds.length > 0) {
      await sendPushToAdminUsers(mentions.userIds, {
        title: `${CLAUDE_SENDER_NAME} mentioned you`,
        body: preview,
        url,
        tag: `team-mention-${target.thread_id}`,
      })
    } else if (target.thread_type === 'dm') {
      // A DM goes to the ONE other participant. It used to broadcast, so a note
      // Claude sent privately to Luca previewed on every staff device. A DM the
      // acting user dictated TO THEMSELF pushes nobody.
      const otherId = (target.dm_key ?? '').split(':').find(id => id && id !== CLAUDE_SENDER_UUID)
      if (otherId && otherId !== actingUserId) {
        await sendPushToAdminUsers([otherId], { title: CLAUDE_SENDER_NAME, body: preview, url, tag })
      }
    } else if (target.thread_type === 'channel' || target.thread_type === 'general') {
      // SAME silence rule as the human send route — Claude answering in the
      // machine-written bug channel must not buzz phones. The MCP tool tells
      // Claude to prefer root_id when answering a bug, and worker bug reports
      // end with "@claude — investigate", so this path is genuinely reachable.
      if (channelNotifiesStaff(target.channel_slug ?? target.channel_name ?? null)) {
        await sendPushToStaffExcept(CLAUDE_SENDER_UUID, { title: CLAUDE_SENDER_NAME, body: preview, url, tag }, actingUserId ? [actingUserId] : undefined)
      }
    } else {
      // A client discussion: participants only, never every staff device.
      const { data: participants } = await admin
        .from('internal_thread_reads')
        .select('user_id')
        .eq('thread_id', target.thread_id)
      const ids = ((participants ?? []) as { user_id: string }[])
        .map(p => p.user_id)
        .filter(uid => uid && uid !== CLAUDE_SENDER_UUID && uid !== actingUserId)
      if (ids.length > 0) {
        await sendPushToAdminUsers(ids, { title: CLAUDE_SENDER_NAME, body: preview, url, tag })
      }
    }
  } catch {
    // non-critical
  }

  return {
    thread_id: target.thread_id,
    message_id: msg.id as string,
    thread_type: target.thread_type,
    mentioned_user_ids: mentions.userIds,
    root_id: rootId,
  }
}
