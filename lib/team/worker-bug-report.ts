import 'server-only'

/**
 * WORKER BUG REPORT → a thread in the #td-worker-bug channel (dev job a6c3d75b,
 * Antonio 2026-07-18: "I don't have time to go back and forth from the board to
 * check it. It would be better if in team workspace you create a thread under
 * td-worker-bug").
 *
 * WHY THIS SHAPE. The system has recorded every correction Antonio makes for
 * months — the correction detector runs on every surface and writes the lesson to
 * memory. Nobody ever read that output, so Antonio stayed the quality check. A
 * weekly digest would still be something he has to remember to open; a thread
 * appearing in a channel he already works in is something he just sees, with the
 * detail inline instead of behind a link. @claude is already in Team Chat, so he
 * can reply "fix this" in the thread and it gets picked up.
 *
 * NOISE IS THE REAL RISK: a channel that pings on every trivial "make it shorter"
 * gets muted, which is worse than no report at all. So this fires ONLY when the
 * correction produced a durable lesson (i.e. the extractor judged there was
 * something reusable to learn) — see the caller. Start strict; loosen if quiet.
 *
 * Best-effort in every direction: it must never break a worker turn, and it is
 * idempotent per captured lesson so a retry can't double-post.
 *
 * LOOP-SAFETY: the row is inserted directly as the Claude sentinel sender, not
 * through the team send route, so it cannot trigger the @claude responder (which
 * only fires on human-authored messages via that route).
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { CLAUDE_SENDER_UUID, CLAUDE_SENDER_NAME } from '@/lib/team/workspace'

/** The channel Antonio nominated. Threads land here, nowhere else. */
export const WORKER_BUG_CHANNEL = 'td-worker-bug'

export interface WorkerBugReportInput {
  /** What the staff member had asked (their raw message this turn). */
  staffMessage: string
  /** What the worker had replied, and is now being corrected on. */
  priorReply: string
  /** Which surface it happened on, e.g. "portal_chat", "inbox", "team_chat", "slack". */
  surface: string
  /** Client display name, when the turn was about one. */
  clientName?: string | null
  /** Canonical client scope, when known. */
  clientKey?: string | null
  /** The lesson that was learned — used for the title. */
  lessonSituation: string
  lessonDecision: string
  /** The saved memory id — the idempotency key, so a retry can't double-post. */
  memoryId: string
}

/** Trim to a single tidy line for a thread title. */
function titleLine(s: string, max = 140): string {
  const one = (s ?? '').replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** Plain-English surface name — Antonio should not read internal keys. */
function surfaceLabel(surface: string): string {
  switch (surface) {
    case 'portal_chat': return 'Portal Chats'
    case 'inbox': return 'Inbox'
    case 'team_chat': return 'Team Chat'
    case 'slack': return 'Slack'
    case 'dashboard': return 'CRM assistant'
    case 'hermes': return 'Hermes bridge'
    default: return surface
  }
}

/**
 * Post one thread describing a mistake the worker just made and was corrected on.
 * Returns the root message id, or null when nothing was posted (channel missing,
 * already reported, or any failure — all non-fatal).
 */
export async function reportWorkerMistake(input: WorkerBugReportInput): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any

    // The channel must already exist — never silently create channels.
    const { data: channel } = await db
      .from('internal_threads')
      .select('id')
      .eq('channel_name', WORKER_BUG_CHANNEL)
      .limit(1)
      .maybeSingle()
    if (!channel?.id) return null

    // Idempotent per captured lesson: a retry of the same turn must not re-post.
    const marker = `worker-bug:${input.memoryId}`
    const { data: existing } = await db
      .from('internal_messages')
      .select('id')
      .eq('thread_id', channel.id)
      .ilike('message', `%${marker}%`)
      .limit(1)
    if (existing?.length) return null

    const who = input.clientName?.trim()
      ? `${input.clientName.trim()}`
      : input.clientKey?.trim()
        ? 'a client'
        : 'no specific client'

    const title = `Worker got it wrong — ${titleLine(input.lessonSituation, 110)}`
    const body = [
      title,
      '',
      `**Where:** ${surfaceLabel(input.surface)} · **Client:** ${who}`,
      '',
      '**You asked / said**',
      `> ${titleLine(input.staffMessage, 600)}`,
      '',
      '**What it had answered**',
      `> ${titleLine(input.priorReply, 600)}`,
      '',
      '**What it learned**',
      input.lessonDecision.trim(),
      '',
      `_Saved to memory automatically. Reply here with @claude to get it fixed._`,
      `<!-- ${marker} -->`,
    ].join('\n')

    const now = new Date().toISOString()
    const { data: msg, error } = await db
      .from('internal_messages')
      .insert({
        thread_id: channel.id,
        sender_id: CLAUDE_SENDER_UUID,
        sender_name: CLAUDE_SENDER_NAME,
        message: body,
        read_at: null,
      })
      .select('id')
      .single()
    if (error || !msg?.id) return null

    // Register it as a real thread with its own title, so it shows in the panel.
    await db
      .from('internal_thread_state')
      .upsert(
        {
          root_message_id: msg.id,
          thread_id: channel.id,
          status: 'todo',
          title: titleLine(title, 200),
          created_as_thread: true,
          updated_at: now,
          updated_by: CLAUDE_SENDER_UUID,
        },
        { onConflict: 'root_message_id' },
      )
      .then(() => {}, () => {})

    await db
      .from('internal_threads')
      .update({ last_activity_at: now })
      .eq('id', channel.id)
      .then(() => {}, () => {})

    return msg.id as string
  } catch (err) {
    console.warn('[worker-bug-report] could not post (non-fatal):', err)
    return null
  }
}
