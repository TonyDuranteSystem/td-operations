import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser, isAdmin, getUserDisplayName } from '@/lib/auth'
import { validateTeamCard } from '@/lib/team/workspace'
import { resolveMentions } from '@/lib/team/directory'
import { triggerClaudeReply } from '@/lib/team/claude-trigger'
import { sendPushToAdminUsers, sendPushToAdminExcluding } from '@/lib/portal/web-push'
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

  // Thread must exist.
  const { data: thread } = await supabaseAdmin
    .from('internal_threads')
    .select('id, thread_type, account_id')
    .eq('id', threadId)
    .single()
  if (!thread) return NextResponse.json({ error: 'Thread not found' }, { status: 404 })

  // reply_to must belong to this thread.
  if (replyToId) {
    const { data: parent } = await supabaseAdmin
      .from('internal_messages')
      .select('id')
      .eq('id', replyToId)
      .eq('thread_id', threadId)
      .single()
    if (!parent) {
      return NextResponse.json({ error: 'reply_to_id not found in this thread' }, { status: 400 })
    }
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
      attachments,
      card: card ?? null,
      mentions: mentions.matchedHandles.length ? mentions.matchedHandles : [],
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
    if (mentions.userIds.length > 0) {
      // Targeted: only the mentioned teammates.
      await sendPushToAdminUsers(mentions.userIds, {
        title: `${displayName} mentioned you`,
        body: preview,
        url: `/team-chat?thread=${threadId}`,
        tag: `team-mention-${threadId}`,
      })
    } else {
      // General thread activity: notify the rest of the team (not the sender).
      await sendPushToAdminExcluding(user.id, {
        title: displayName,
        body: preview,
        url: `/team-chat?thread=${threadId}`,
        tag: `team-thread-${threadId}`,
      })
    }
  } catch {
    // non-critical
  }

  // @claude trigger — fire the AI worker adapter (loop-safe: only human sends
  // reach this route; the processor also refuses Claude-authored prompts).
  let claudePlaceholderId: string | null = null
  if (mentions.claude) {
    try {
      claudePlaceholderId = await triggerClaudeReply({
        threadId,
        promptBody: message,
        promptMessageId: msg.id,
        senderIsAntonio: isAdmin(user),
      })
    } catch (err) {
      console.error('[team] claude trigger failed:', err instanceof Error ? err.message : err)
    }
  }

  return NextResponse.json({ message: msg, claude_pending: claudePlaceholderId })
}
