import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser, isAdmin, getUserDisplayName } from '@/lib/auth'
import { validateTeamCard } from '@/lib/team/workspace'
import { resolveMentions } from '@/lib/team/directory'
import { triggerClaudeReply } from '@/lib/team/claude-trigger'
import { sendPushToAdminUsers } from '@/lib/portal/web-push'
import type { ChatAttachment } from '@/lib/types'
import { NextRequest, NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '') ?? ''

/**
 * POST /api/team/threads/[id]/messages
 * Send a message into a team thread. Handles @mentions (targeted push +
 * @claude AI trigger), colored rich cards, attachments, and quote-replies.
 * Staff-only.
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

  const message: string = (body.message ?? '').toString().trim()
  const replyToId: string | null = body.reply_to_id ?? null
  const attachments: ChatAttachment[] | null = Array.isArray(body.attachments) && body.attachments.length ? body.attachments : null
  const card = body.card ?? null

  const hasContent = message || attachments?.length || card
  if (!hasContent) {
    return NextResponse.json({ error: 'message, attachment, or card required' }, { status: 400 })
  }
  if (message.length > 5000) {
    return NextResponse.json({ error: 'Message too long (max 5000 characters)' }, { status: 400 })
  }

  // Card validation.
  const cardErr = validateTeamCard(card)
  if (cardErr) return NextResponse.json({ error: cardErr }, { status: 400 })

  // Attachment URL guard (mirror portal chat): every attachment must live on our
  // Storage host — never an arbitrary off-site URL.
  if (attachments && SUPABASE_URL) {
    for (const a of attachments) {
      const u = (a?.url ?? '').toString().trim()
      if (!u.startsWith(SUPABASE_URL)) {
        return NextResponse.json({ error: 'Invalid attachment URL' }, { status: 400 })
      }
    }
  }

  // Thread must exist. (as-any: generated types predate thread_type — same
  // escape as every other internal_threads site in this route family.)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: thread } = await (supabaseAdmin as any)
    .from('internal_threads')
    .select('id, thread_type, account_id, dm_key')
    .eq('id', threadId)
    .single()
  if (!thread) return NextResponse.json({ error: 'Thread not found' }, { status: 404 })

  // reply_to must belong to this thread. Capture the parent's root so this
  // reply is stamped with the thread's ORIGINAL message (Slack-style 2-level
  // threading): a reply always flattens to the root, even a reply-to-a-reply.
  let rootId: string | null = null
  if (replyToId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: parent } = await (supabaseAdmin as any)
      .from('internal_messages')
      .select('id, root_id')
      .eq('id', replyToId)
      .eq('thread_id', threadId)
      .single()
    if (!parent) {
      return NextResponse.json({ error: 'reply_to_id not found in this thread' }, { status: 400 })
    }
    rootId = parent.root_id ?? parent.id
  }

  // Resolve @mentions against the staff directory.
  const mentions = await resolveMentions(message, user.id)

  const displayName = getUserDisplayName(user)
  const now = new Date().toISOString()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: msg, error } = await (supabaseAdmin as any)
    .from('internal_messages')
    .insert({
      thread_id: threadId,
      sender_id: user.id,
      sender_name: displayName,
      message,
      reply_to_id: replyToId,
      root_id: rootId,
      attachments,
      card: card ?? null,
      mentions: mentions.matchedHandles.length ? mentions.matchedHandles : [],
      // Resolved USER IDS (sender already excluded) — the queryable source for
      // the Mentions inbox/badge; handles above stay for display only.
      mentioned_user_ids: mentions.userIds,
      read_at: now,
    })
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Bump thread activity so the sidebar re-sorts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from('internal_threads')
    .update({ last_activity_at: now })
    .eq('id', threadId)

  // The sender has implicitly read their own message.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from('internal_thread_reads')
    .upsert({ thread_id: threadId, user_id: user.id, last_read_at: now, updated_at: now }, { onConflict: 'thread_id,user_id' })

  // Notifications (best-effort, never block the send).
  try {
    const preview = message.slice(0, 120) || (attachments?.length ? `📎 ${attachments[0].name}` : card ? '📇 Shared a card' : 'New message')
    // Deep-link: a reply opens the thread pane on its root; a top-level message
    // opens the channel.
    const threadUrl = `/team-chat?thread=${threadId}${rootId ? `&root=${rootId}` : ''}`
    // Push ONLY for a DM (to the other participant), an @mention (to the
    // mentioned teammates), a client-conversation you're in, or a THREAD REPLY
    // (to that thread's participants) — Antonio 2026-07-09. Ordinary top-level
    // channel chatter still buzzes no one (matches the DM/@mention dot).
    if (mentions.userIds.length > 0) {
      await sendPushToAdminUsers(mentions.userIds, {
        title: `${displayName} mentioned you`,
        body: preview,
        url: threadUrl,
        tag: `team-mention-${threadId}`,
      })
    } else if (thread.thread_type === 'dm') {
      const otherId = (thread.dm_key ?? '').split(':').find((id: string) => id && id !== user.id)
      if (otherId) {
        await sendPushToAdminUsers([otherId], {
          title: displayName,
          body: preview,
          url: threadUrl,
          tag: `team-dm-${threadId}`,
        })
      }
    } else if (rootId && (thread.thread_type === 'channel' || thread.thread_type === 'general')) {
      // Slack-style thread reply in a channel: ping only the people IN this
      // thread (root author + prior repliers), never the whole channel.
      const { CLAUDE_SENDER_UUID } = await import('@/lib/team/workspace')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: participants } = await (supabaseAdmin as any)
        .from('internal_messages')
        .select('sender_id')
        .eq('thread_id', threadId)
        .or(`id.eq.${rootId},root_id.eq.${rootId}`)
      const ids = (Array.from(new Set((participants ?? []).map((p: { sender_id: string }) => p.sender_id))) as string[])
        .filter((uid) => uid && uid !== user.id && uid !== CLAUDE_SENDER_UUID)
      if (ids.length > 0) {
        await sendPushToAdminUsers(ids, {
          title: `${displayName} replied in a thread`,
          body: preview,
          url: threadUrl,
          tag: `team-thread-${rootId}`,
        })
      }
    } else if (thread.thread_type === 'discussion') {
      // A client conversation: ping its PARTICIPANTS (anyone with a read row —
      // opened / posted / shared into), never the whole team. The CLAUDE
      // sentinel and the sender are excluded. This is the participant model that
      // keeps channel chatter silent while a conversation you're in rings.
      const { CLAUDE_SENDER_UUID } = await import('@/lib/team/workspace')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: participants } = await (supabaseAdmin as any)
        .from('internal_thread_reads')
        .select('user_id')
        .eq('thread_id', threadId)
      const ids = (participants ?? [])
        .map((p: { user_id: string }) => p.user_id)
        .filter((uid: string) => uid && uid !== user.id && uid !== CLAUDE_SENDER_UUID)
      if (ids.length > 0) {
        await sendPushToAdminUsers(ids, {
          title: `${displayName} · ${thread.title ?? 'Conversation'}`,
          body: preview,
          url: threadUrl,
          tag: `team-conversation-${threadId}`,
        })
      }
    }
    // else: channel / general → intentionally silent.
  } catch {
    // non-critical
  }

  // ── In-thread approval completion (Slack-parity rail) ──────────────────
  // An ADMIN message that is EXACTLY a 6-digit code completes the pending
  // proposal linked to this thread — deterministically, without the LLM.
  // OFF (2026-07-10, Antonio): the worker no longer queues actions, so there is
  // nothing to approve by code. Gated on the same rail switch (reversible) — a
  // 6-digit message is just a normal chat message while the rail is off.
  const { workerActionsEnabled } = await import('@/lib/ai-agent/worker-actions-switch')
  if (workerActionsEnabled() && isAdmin(user)) {
    const { isSixDigitCode, handleTeamApprovalCode } = await import('@/lib/team/team-approval')
    if (isSixDigitCode(message)) {
      const outcome = await handleTeamApprovalCode({ code: message, threadId, isAdminSender: true })
      if (outcome.handled) {
        const { CLAUDE_SENDER_UUID, CLAUDE_SENDER_NAME } = await import('@/lib/team/workspace')
        await supabaseAdmin.from('internal_messages').insert({
          thread_id: threadId,
          sender_id: CLAUDE_SENDER_UUID,
          sender_name: CLAUDE_SENDER_NAME,
          message: outcome.message,
          reply_to_id: msg.id,
          root_id: msg.root_id ?? msg.id,
          read_at: now,
        })
        return NextResponse.json({ message: msg, approval_handled: true })
      }
    }
  }

  // @claude trigger — fire the AI worker adapter (loop-safe: only human sends
  // reach this route; the processor also refuses Claude-authored prompts).
  // Invitation gate (Slack parity, Antonio 2026-07-08): in a client DISCUSSION
  // where Claude has already participated, plain text messages continue the
  // conversation without re-mentioning — like Slack thread replies after a
  // mentioned parent. Channels/general/DMs still require an explicit @claude.
  let invokeClaude = mentions.claude
  if (!invokeClaude && message && thread.thread_type === 'discussion') {
    const { shouldAutoContinueWithClaude, CLAUDE_SENDER_UUID } = await import('@/lib/team/workspace')
    // Discussions render flat (Slack threads are a channel-only feature in v1),
    // so the "Claude already participated" check stays thread-wide to preserve
    // the invitation-gate continuation.
    const { data: claudeMsg } = await supabaseAdmin
      .from('internal_messages')
      .select('id')
      .eq('thread_id', threadId)
      .eq('sender_id', CLAUDE_SENDER_UUID)
      .limit(1)
      .maybeSingle()
    invokeClaude = shouldAutoContinueWithClaude({
      threadType: thread.thread_type,
      claudeHasParticipated: !!claudeMsg,
      bodyMentionsClaude: mentions.claude,
    })
  }
  let claudePlaceholderId: string | null = null
  if (invokeClaude) {
    try {
      claudePlaceholderId = await triggerClaudeReply({
        threadId,
        promptBody: message,
        promptMessageId: msg.id,
        promptRootId: msg.root_id ?? msg.id,
        senderIsAntonio: isAdmin(user),
        force: true,
      })
    } catch (err) {
      console.error('[team] claude trigger failed:', err instanceof Error ? err.message : err)
    }
  }

  return NextResponse.json({ message: msg, claude_pending: claudePlaceholderId })
}
