/**
 * Team Workspace — @claude AI worker adapter (server-only).
 *
 * When a human @mentions claude in a team thread, we:
 *   1. insert a placeholder "…thinking" message authored by Claude (so the UI
 *      shows a pending bubble immediately), and
 *   2. fire a bounded direct-trigger to /api/team/claude/process, which runs the
 *      shared worker (callWorker) and rewrites the placeholder with the answer.
 *
 * This mirrors the Slack worker's direct-fire pattern (getInternalBaseUrl +
 * CRON_SECRET + short AbortController) so a long investigation keeps running
 * server-side after the send route returns.
 *
 * Loop-safety: only HUMAN-authored messages ever reach triggerClaudeReply (the
 * send route is the sole caller and Claude's own posts go in via the sentinel
 * sender, never through the send route). The processor also refuses to act on a
 * message authored by the Claude sentinel.
 */
import 'server-only'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getInternalBaseUrl } from '@/lib/mcp/tools/agent-messages'
import { CLAUDE_SENDER_UUID, CLAUDE_SENDER_NAME, mentionsClaude } from '@/lib/team/workspace'

const THINKING_PLACEHOLDER = '…'

/**
 * Insert the Claude placeholder message and fire the async processor.
 * Returns the placeholder message id (or null if @claude wasn't actually
 * mentioned / insert failed — caller can ignore).
 */
export async function triggerClaudeReply(params: {
  threadId: string
  promptBody: string
  promptMessageId: string
  senderIsAntonio: boolean
}): Promise<string | null> {
  const { threadId, promptBody, promptMessageId, senderIsAntonio } = params
  if (!mentionsClaude(promptBody)) return null

  // 1. Placeholder bubble authored by Claude. reply_to_id links it to the
  //    triggering human message — that renders as a quoted reply AND gives the
  //    cron rescue an exact pointer to the prompt if the direct fire is lost.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: placeholder, error } = await (supabaseAdmin as any)
    .from('internal_messages')
    .insert({
      thread_id: threadId,
      sender_id: CLAUDE_SENDER_UUID,
      sender_name: CLAUDE_SENDER_NAME,
      message: THINKING_PLACEHOLDER,
      reply_to_id: promptMessageId,
      read_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (error || !placeholder) {
    console.error('[team-claude] placeholder insert failed:', error?.message)
    return null
  }

  // 2. Fire the processor (bounded — it keeps running server-side after abort).
  const url = `${getInternalBaseUrl()}/api/team/claude/process`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2500)
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.CRON_SECRET ?? ''}`,
      },
      body: JSON.stringify({
        thread_id: threadId,
        prompt_message_id: promptMessageId,
        placeholder_id: placeholder.id,
        sender_is_antonio: senderIsAntonio,
      }),
      signal: controller.signal,
    })
  } catch {
    // AbortError expected; processor runs server-side. (No cron net yet — Phase 1.)
  } finally {
    clearTimeout(timeout)
  }

  return placeholder.id
}

/**
 * Run the worker for a team @claude mention and rewrite the placeholder with the
 * answer. Called by /api/team/claude/process. Idempotent-ish: if the placeholder
 * has already been answered (message != placeholder), it no-ops.
 */
export async function processClaudeReply(params: {
  threadId: string
  promptMessageId: string
  placeholderId: string
  senderIsAntonio: boolean
}): Promise<{ ok: boolean; reason?: string }> {
  const { threadId, promptMessageId, placeholderId, senderIsAntonio } = params

  // Load the placeholder + guard against double-processing and self-trigger.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: placeholder } = await (supabaseAdmin as any)
    .from('internal_messages')
    .select('id, message, sender_id')
    .eq('id', placeholderId)
    .single()
  if (!placeholder) return { ok: false, reason: 'placeholder_gone' }
  if (placeholder.sender_id !== CLAUDE_SENDER_UUID) return { ok: false, reason: 'not_claude_placeholder' }
  if (placeholder.message !== THINKING_PLACEHOLDER) return { ok: false, reason: 'already_answered' }

  // The triggering human message.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: prompt } = await (supabaseAdmin as any)
    .from('internal_messages')
    .select('id, message, sender_id, sender_name')
    .eq('id', promptMessageId)
    .single()
  if (!prompt) return await failPlaceholder(placeholderId, 'The triggering message could not be found.')
  if (prompt.sender_id === CLAUDE_SENDER_UUID) {
    // Loop guard: never answer our own message.
    return { ok: false, reason: 'self_message' }
  }

  // Thread context: client linkage (per-client brain) + recent conversation.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: thread } = await (supabaseAdmin as any)
    .from('internal_threads')
    .select('id, account_id, contact_id, channel_name, title')
    .eq('id', threadId)
    .single()

  let clientKey: string | null = null
  let clientName: string | null = null
  if (thread?.account_id) {
    const { data: acct } = await supabaseAdmin
      .from('accounts')
      .select('company_name')
      .eq('id', thread.account_id)
      .single()
    clientKey = `account:${thread.account_id}`
    clientName = acct?.company_name ?? null
  } else if (thread?.contact_id) {
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('full_name')
      .eq('id', thread.contact_id)
      .single()
    clientKey = `contact:${thread.contact_id}`
    clientName = contact?.full_name ?? null
  }

  // Recent conversation (exclude the placeholder itself) for context.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: recent } = await (supabaseAdmin as any)
    .from('internal_messages')
    .select('sender_name, message, created_at')
    .eq('thread_id', threadId)
    .is('deleted_at', null)
    .neq('id', placeholderId)
    .order('created_at', { ascending: false })
    .limit(12)

  const history = (recent ?? [])
    .reverse()
    .map((m: { sender_name: string; message: string }) => `${m.sender_name}: ${m.message}`)
    .join('\n')

  const contextBlock = history
    ? `RECENT TEAM CHAT (for reference — you are "Claude", a teammate in this internal staff thread):\n${history}\n\n`
    : ''

  const userBody = `${contextBlock}The latest message mentions you (@claude):\n${prompt.sender_name}: ${prompt.message}\n\nReply as a concise, helpful teammate. This is an INTERNAL staff thread (never client-visible).`

  let reply: string
  try {
    const { callWorker } = await import('@/lib/ai-agent/worker-tools')
    const res = await callWorker(userBody, {
      // Read/research rails on for everyone.
      enableDbRead: true,
      enableDocReads: true,
      enableCallReads: true,
      enableCalendly: true,
      enableClientThreadRead: true,
      enableWebSearch: true,
      // Code-task rail Antonio-only (R111). Send rails stay OFF in team chat for
      // now (research-first, mirrors Hermes Phase 1) — a later phase can add them
      // behind the show-draft-first approval discipline.
      enableCodeTasks: senderIsAntonio,
      clientKey,
      clientName,
    })
    reply = res.reply?.trim() || '(no response generated)'
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[team-claude] worker failed:', msg)
    return await failPlaceholder(
      placeholderId,
      msg.includes('ANTHROPIC_API_KEY')
        ? '⚠️ AI is not configured in this environment (ANTHROPIC_API_KEY missing).'
        : '⚠️ I hit an error working on that. Please try again.',
    )
  }

  // Rewrite the placeholder with the answer + bump thread activity.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from('internal_messages')
    .update({ message: reply })
    .eq('id', placeholderId)
    .eq('message', THINKING_PLACEHOLDER) // TOCTOU guard: only if still pending

  await bumpThreadActivity(threadId)
  return { ok: true }
}

/**
 * Cron rescue — process placeholders whose direct fire was lost.
 *
 * The send route fires /api/team/claude/process with a 2.5s-bounded fetch; on
 * Vercel that fire-and-forget can occasionally be dropped before the target
 * invocation starts (same failure mode the Slack worker has — its cron is the
 * safety net there, and this is the equivalent net here). Finds "…" placeholders
 * older than STUCK_AFTER_MS and runs them. The prompt is recovered from the
 * placeholder's reply_to_id (set at trigger time); legacy placeholders without
 * it fall back to the nearest earlier human message in the thread.
 */
const STUCK_AFTER_MS = 45_000
const RESCUE_BATCH = 3

export async function rescueStuckClaudeReplies(): Promise<{ scanned: number; rescued: number }> {
  const cutoff = new Date(Date.now() - STUCK_AFTER_MS).toISOString()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: stuck } = await (supabaseAdmin as any)
    .from('internal_messages')
    .select('id, thread_id, reply_to_id, created_at')
    .eq('sender_id', CLAUDE_SENDER_UUID)
    .eq('message', THINKING_PLACEHOLDER)
    .is('deleted_at', null)
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(RESCUE_BATCH)

  let rescued = 0
  for (const ph of stuck ?? []) {
    let promptId: string | null = ph.reply_to_id
    if (!promptId) {
      // Legacy placeholder (pre reply_to_id): nearest earlier human message.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: prev } = await (supabaseAdmin as any)
        .from('internal_messages')
        .select('id')
        .eq('thread_id', ph.thread_id)
        .neq('sender_id', CLAUDE_SENDER_UUID)
        .is('deleted_at', null)
        .lt('created_at', ph.created_at)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      promptId = prev?.id ?? null
    }
    if (!promptId) {
      await failPlaceholder(ph.id, '⚠️ I lost track of the question this was answering — please ask again.')
      continue
    }

    // Recover the code-task gate (R111): Antonio-only, keyed on the prompt author.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: prompt } = await (supabaseAdmin as any)
      .from('internal_messages')
      .select('sender_id')
      .eq('id', promptId)
      .single()
    const senderIsAntonio = prompt?.sender_id ? await isAntonioUser(prompt.sender_id) : false

    const res = await processClaudeReply({
      threadId: ph.thread_id,
      promptMessageId: promptId,
      placeholderId: ph.id,
      senderIsAntonio,
    })
    if (res.ok) rescued++
  }
  return { scanned: (stuck ?? []).length, rescued }
}

/** Mirror of lib/auth isAdmin, usable from a cron (no session): admin role or
 *  Antonio's email. Default-safe: unknown/missing user → false. */
async function isAntonioUser(userId: string): Promise<boolean> {
  try {
    const { data } = await supabaseAdmin.auth.admin.getUserById(userId)
    const u = data?.user
    if (!u) return false
    return (
      u.email === 'antonio.durante@tonydurante.us' ||
      u.app_metadata?.role === 'admin' ||
      (u.user_metadata as Record<string, unknown> | undefined)?.role === 'admin'
    )
  } catch {
    return false
  }
}

async function failPlaceholder(placeholderId: string, message: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from('internal_messages')
    .update({ message })
    .eq('id', placeholderId)
    .eq('message', THINKING_PLACEHOLDER)
  return { ok: false, reason: 'worker_error' }
}

async function bumpThreadActivity(threadId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from('internal_threads')
    .update({ last_activity_at: new Date().toISOString() })
    .eq('id', threadId)
}
