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
import type { WorkerImageBlock, WorkerDocumentBlock } from '@/lib/ai-agent/worker-tools'

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
  /** The thread ROOT of the prompt (prompt.root_id ?? prompt.id). Claude's
   *  answer is stamped with this so it stays inside the same Slack-style thread
   *  the question was asked in, instead of escaping to the main channel. */
  promptRootId?: string | null
  /** Invitation-gate continuation: the route determined this thread is an
   *  active Claude conversation (discussion + prior Claude participation), so
   *  run without requiring an in-body @claude. */
  force?: boolean
}): Promise<string | null> {
  const { threadId, promptBody, promptMessageId, senderIsAntonio, promptRootId, force } = params
  if (!force && !mentionsClaude(promptBody)) return null

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
      root_id: promptRootId ?? promptMessageId,
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
  const { threadId, promptMessageId, placeholderId } = params

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

  // The triggering human message. `attachments` matters: staff drop screenshots
  // and PDFs into team chat and expect @claude to look at them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: prompt } = await (supabaseAdmin as any)
    .from('internal_messages')
    .select('id, message, sender_id, sender_name, attachments')
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
    .select('id, sender_id, sender_name, message, attachments, created_at')
    .eq('thread_id', threadId)
    .is('deleted_at', null)
    .neq('id', placeholderId)
    .order('created_at', { ascending: false })
    .limit(12)

  const history = (recent ?? [])
    .slice()
    .reverse()
    .map((m: { sender_name: string; message: string }) => `${m.sender_name}: ${m.message}`)
    .join('\n')

  const contextBlock = history
    ? `RECENT TEAM CHAT (for reference — you are "Claude", a teammate in this internal staff thread):\n${history}\n\n`
    : ''

  let userBody = `${contextBlock}The latest message mentions you (@claude):\n${prompt.sender_name}: ${prompt.message}`

  // Attachments. Take them from the @mention itself, or — when it carries none —
  // from the most recent earlier HUMAN message that does. Staff routinely post a
  // screenshot and then @claude in the next message ("look at this"), exactly the
  // way they do in Slack, where the worker harvests thread history for the same
  // reason. `recent` is newest-first, so the first hit is the nearest one.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasFiles = (m: any) => Array.isArray(m?.attachments) && m.attachments.length > 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const carrier = hasFiles(prompt) ? prompt : (recent ?? []).find((m: any) => m.sender_id !== CLAUDE_SENDER_UUID && hasFiles(m))

  const media = { imageBlocks: [] as WorkerImageBlock[], documentBlocks: [] as WorkerDocumentBlock[] }
  if (carrier) {
    try {
      const { readAttachments, fetchTrustedStorageBytes, attachmentRefsFromChatRow, capMediaBudget, fenceUntrustedContent } = await import(
        '@/lib/ai-agent/attachment-reader'
      )
      const read = await readAttachments(attachmentRefsFromChatRow(carrier), fetchTrustedStorageBytes)
      // Keep the whole turn under the Anthropic request ceiling; name what's dropped.
      const capped = capMediaBudget(read.imageBlocks, read.documentBlocks)
      media.imageBlocks = capped.images
      media.documentBlocks = capped.documents
      if (read.textBlocks.length) {
        const whose = carrier.id === prompt.id ? 'this message' : `an earlier message from ${carrier.sender_name}`
        // Team Chat has email + portal send rails, so a shared file's text must
        // never be able to read as an instruction or as an approval to send.
        userBody += `\n\n${fenceUntrustedContent(`files shared in ${whose}`, read.textBlocks.join('\n\n'))}`
      }
      if (capped.dropped.length) {
        userBody += `\n\n[Too much was attached to show you everything. Not shown: ${capped.dropped.join(', ')}.]`
      }
    } catch (err) {
      // Never block the reply on attachment reading.
      console.warn('[team-claude] attachment read failed (answering without files):', err)
    }
  }

  let reply: string
  try {
    const { callWorkerWithAttachments } = await import('@/lib/ai-agent/attachment-reader')
    // FULL SLACK PARITY (parity matrix 2026-07-08, after the "send it in the
    // thread" incident): the Team Chat worker runs with the SAME configuration
    // as the Slack worker — same persona/discipline prompt (SOURCES FIRST, TWO
    // GEARS, DRAFTS, send-after-explicit-"send it"), same send rails, same
    // iteration budget, same billing key. Differences are transport-only:
    //  - threadId = the TEAM thread uuid → worker thread memory AND
    //    approval_queue.thread_id linkage for the in-chat 6-digit code rail.
    //  - messageId is NOT passed: approval_queue.source_message_id FKs
    //    agent_messages(id) (Slack rows) — a team message id would violate it.
    //  - enableClientThreadTag stays off (that rail is #td-support-specific).
    const { SLACK_WORKER_SYSTEM_PROMPT } = await import('@/lib/ai-agent/slack-claude')
    const { loadRelevantTemplates, formatTemplatesForPrompt } = await import('@/lib/ai-agent/templates')

    let systemPrompt = `${SLACK_WORKER_SYSTEM_PROMPT}\n\nCONTEXT CORRECTION: you are in the CRM TEAM CHAT (crm.tonydurante.us → Team Chat), not Slack. Same team, same rules, same tools — replies render as chat messages in this internal thread (never client-visible).`
    try {
      const templates = await loadRelevantTemplates(prompt.message)
      const block = formatTemplatesForPrompt(templates)
      if (block) systemPrompt += `\n${block}`
    } catch { /* best-effort, same as Slack */ }

    const res = await callWorkerWithAttachments(userBody, {
      threadId,
      systemPromptOverride: systemPrompt,
      apiKeyOverride: process.env.SLACK_WORKER_ANTHROPIC_KEY,
      maxIterations: 20,
      // Files shared in the thread, handed to the model directly (vision for
      // images, native blocks for scanned PDFs). Extracted text for everything
      // else is already appended to userBody above.
      ...(media.imageBlocks.length ? { images: media.imageBlocks } : {}),
      ...(media.documentBlocks.length ? { documents: media.documentBlocks } : {}),
      // Read/research rails.
      enableDbRead: true,
      enableDocReads: true,
      enableCallReads: true,
      enableCalendly: true,
      enableClientThreadRead: true,
      enableWebSearch: true,
      enableThreadRecall: true,
      enableFullToolReach: process.env.ASSISTANT_FULL_REACH_ENABLED === 'true',
      // Send rails — Slack parity: draft in thread, send on explicit "send it"
      // (discipline enforced by SLACK_WORKER_SYSTEM_PROMPT, same as Slack).
      enableEmailSend: true,
      enableSlackSend: true,
      // Internal team-chat send (staff-only, posts as Claude). Same draft →
      // explicit "send it" discipline. Answering @claude already runs in team
      // chat; this lets it post to OTHER team channels/threads on approval.
      enableTeamChatSend: true,
      // Code-task rail OFF (2026-07-10, Antonio): the team-chat worker never
      // launches or ships a coding job — it investigates and reports; Antonio
      // does code himself. (Reverses the earlier Antonio-only gate.)
      enableCodeTasks: false,
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

  // PERMANENT MEMORY (council redo WS1.4): record this @claude exchange in
  // agent_messages so the assistant actually REMEMBERS this thread beyond the
  // last-12 window — buildThreadContext ("CONVERSATION SO FAR") and the
  // recall_thread tool both read agent_messages by thread_id, which was ALWAYS
  // EMPTY for team threads (a tool that lied to the model). We store the RAW
  // prompt + reply (never the enriched userBody, which already contains the
  // last-12 recap — storing that would nest recap-in-recap on the next turn).
  // recipient='worker' keeps it isolated from the Slack/Hermes crons (they
  // claim recipient='claude'); status='done' so it never engages the CRM
  // per-thread in-flight lock. Best-effort — never blocks the reply.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabaseAdmin as any).from('agent_messages').insert({
      sender: 'crm',
      recipient: 'worker',
      subject: clientName || 'Team chat (@claude)',
      body: prompt.message,
      reply,
      status: 'done',
      thread_id: threadId,
      context_json: {
        source: 'crm-worker',
        surface: 'team-chat',
        user_message: prompt.message,
        ...(clientKey ? { client_key: clientKey } : {}),
      },
    })
  } catch (err) {
    console.warn('[team-claude] memory write failed (reply still delivered):', err)
  }

  // BUSINESS BRAIN capture (dev job 203cda1a): if this staff message corrected the
  // worker's PRIOR reply in this thread, learn the lesson. Team chat is staff-only,
  // so this turn is staff by construction. Client-scoped when the thread is linked
  // to a client; else global + scrubbed (Antonio's policy). Inputs are the RAW staff
  // message + the prior worker reply ONLY (never userBody — it carries the last-12
  // recap + fenced files). Best-effort, never blocks the reply.
  try {
    const priorReply = (recent ?? []).find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (m: any) => m.sender_id === CLAUDE_SENDER_UUID && m.message && m.message !== THINKING_PLACEHOLDER,
    )?.message as string | undefined
    if (priorReply) {
      const { captureLessonFromTurn } = await import('@/lib/ai-agent/lesson-capture')
      await captureLessonFromTurn({
        staffMessage: prompt.message,
        priorReply,
        clientKey,
        surface: 'team_chat',
        sourceRef: `team:${threadId}:${promptMessageId}`,
        actors: ['antonio', 'claude'],
        mode: 'correction',
      })
    }
  } catch (err) {
    console.warn('[team-claude] brain capture failed (non-fatal):', err)
  }

  // Slack parity: Slack posts the answer as a NEW message so the phone gets a
  // push. In Team Chat the answer replaces the placeholder (no insert → no push
  // path), so push the asker explicitly. Best-effort.
  try {
    const { sendPushToAdminUsers } = await import('@/lib/portal/web-push')
    await sendPushToAdminUsers([prompt.sender_id], {
      title: 'Claude replied',
      body: reply.slice(0, 120),
      url: `/team-chat?thread=${threadId}`,
      tag: `team-claude-${threadId}`,
    })
  } catch { /* non-critical */ }

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
