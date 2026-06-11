/**
 * Slack Claude Worker — core module
 *
 * Provides the always-on Claude presence in Slack:
 *   - SLACK_WORKER_SYSTEM_PROMPT: conversational, discuss-first, Slack-native tone
 *   - slackScopeKey(): canonical key for a channel/thread scope
 *   - postSlackMessage(): thin Slack Web API wrapper
 *   - findOrCreateConversationThread(): maps a Slack scope to a thread_id
 *   - processSlackEvent(): runs callWorker then posts the reply to Slack
 *
 * Handles app_mention events plus follow-up thread replies (message events in
 * a thread Claude already participated in). Conversation continuity via
 * thread_id scoped to (channel OR channel:thread_ts) within a 30-minute window;
 * a threaded reply also matches the channel-level mention that started it.
 */

import { randomUUID } from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { callWorker } from "@/lib/ai-agent/worker-tools"
import { createThreadSummary } from "@/lib/ai-agent/thread-summaries"

// ---------------------------------------------------------------------------
// System prompt — conversational, discuss-first, Slack-native
// ---------------------------------------------------------------------------

export const SLACK_WORKER_SYSTEM_PROMPT = `You are Claude, a member of the Tony Durante LLC operations team, present in Slack.

TONE: Short, conversational, human. This is Slack — not a research report.
Typical response: 2–5 lines. Never walls of text.
Slack markdown: *bold*, \`code\`, _italic_. Bullet points only for ≥3 items.

BEHAVIOR:
1. Task given ("check this email", "look at this client"): do the minimum lookup, then
   report what you found in plain English and ask what to do next. Do NOT act first.
2. Question asked: answer directly and concisely.
3. Discussion requested: engage conversationally. No unilateral decisions.
4. To propose an action (send/update/create): describe it in plain English first, wait
   for Antonio's explicit approval ("yes", "go", "send it", "do it") before calling
   propose_action. Never self-approve or pre-emptively execute.
5. Need more context: ask ONE focused question, not five.

TOOLS: Use tools when asked to look something up. One targeted tool call, report back,
then ask what to do. Do not chain multiple tools speculatively.

CONTEXT: You are in a shared Slack workspace with Antonio (CEO) and sometimes Hermes
(the Telegram AI assistant). Antonio is the decision-maker. You answer, discuss, and
propose — he approves and directs. Hermes handles its own work independently.`.trim()

// Conversation window: how long a scope stays "open" for follow-ups
const SCOPE_WINDOW_MS = 30 * 60 * 1000 // 30 minutes

// ---------------------------------------------------------------------------
// Slack API helpers
// ---------------------------------------------------------------------------

export function slackScopeKey(channelId: string, threadTs: string | null | undefined): string {
  return threadTs ? `${channelId}:${threadTs}` : channelId
}

async function slackApiCall(
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; ts?: string; error?: string }> {
  const token = process.env.SLACK_BOT_TOKEN_CLAUDE
  if (!token) throw new Error("SLACK_BOT_TOKEN_CLAUDE not configured")
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  return res.json() as Promise<{ ok: boolean; ts?: string; error?: string }>
}

/** Post a message to Slack. threadTs makes it a reply in that thread. */
export async function postSlackMessage(
  channelId: string,
  text: string,
  threadTs: string | null | undefined,
): Promise<string | null> {
  const payload: Record<string, unknown> = { channel: channelId, text }
  if (threadTs) payload.thread_ts = threadTs
  const r = await slackApiCall("chat.postMessage", payload)
  if (!r.ok) console.error(`[slack-claude] chat.postMessage failed: ${r.error}`)
  return r.ts ?? null
}

// ---------------------------------------------------------------------------
// Scope → thread_id mapping
// ---------------------------------------------------------------------------

/**
 * Return the thread_id for this Slack scope if one was active in the last 30 min,
 * otherwise create a fresh thread_summaries row.
 *
 * Scope key is stored in context_json.slack_scope_key on every agent_messages row
 * created by the Slack webhook handler.
 */
export async function findOrCreateConversationThread(
  channelId: string,
  threadTs: string | null | undefined,
): Promise<string> {
  const scopeKey = slackScopeKey(channelId, threadTs)
  const channelOnlyKey = channelId // the key WITHOUT thread_ts (channel-level mention)
  const cutoff = new Date(Date.now() - SCOPE_WINDOW_MS).toISOString()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabaseAdmin as any)
    .from("agent_messages")
    .select("thread_id, context_json")
    .not("thread_id", "is", null)
    .gt("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(50)

  const rows = (data ?? []) as Array<{ thread_id: string | null; context_json: unknown }>

  // First pass: exact scope match (channel-level ↔ channel-level, thread ↔ thread)
  for (const row of rows) {
    const ctx = row.context_json as Record<string, unknown> | null
    if (ctx?.slack_scope_key === scopeKey && typeof row.thread_id === "string") {
      return row.thread_id
    }
  }

  // Second pass: a threaded reply whose parent was a channel-level mention.
  // The channel-level row stored scope_key = channelId (no thread_ts), so the
  // exact match above misses it. Prefer the row whose original message ts equals
  // this reply's thread_ts (precise thread-origin link); otherwise fall back to
  // the most recent channel-level row in the window.
  if (threadTs) {
    let channelLevelFallback: string | null = null
    for (const row of rows) {
      const ctx = row.context_json as Record<string, unknown> | null
      if (ctx?.slack_scope_key === channelOnlyKey && typeof row.thread_id === "string") {
        if (ctx?.slack_event_ts === threadTs) {
          return row.thread_id // exact thread-origin match — most precise
        }
        if (!channelLevelFallback) channelLevelFallback = row.thread_id // most recent (rows are DESC)
      }
    }
    if (channelLevelFallback) return channelLevelFallback
  }

  // New scope — create a thread_summaries row for conversation memory
  const threadId = randomUUID()
  await createThreadSummary(threadId, "investigation", `Slack ${scopeKey}`)
  return threadId
}

// ---------------------------------------------------------------------------
// Event processing
// ---------------------------------------------------------------------------

export interface SlackEventRow {
  id: string
  body: string
  thread_id: string | null
  context_json: Record<string, unknown> | null
}

/**
 * Run the Slack worker for one agent_messages row then post the reply to Slack.
 * Called from the slack-claude-worker cron route.
 */
export async function processSlackEvent(row: SlackEventRow): Promise<string> {
  const ctx = row.context_json ?? {}
  const channelId = ctx.slack_channel_id as string | undefined
  const replyThreadTs = (ctx.slack_thread_ts ?? ctx.slack_event_ts) as string | undefined

  if (!channelId) {
    throw new Error(`agent_messages row ${row.id} missing slack_channel_id in context_json`)
  }

  const { reply } = await callWorker(row.body, {
    threadId: row.thread_id,
    messageId: row.id,
    systemPromptOverride: SLACK_WORKER_SYSTEM_PROMPT,
  })

  // Post the reply to Slack first, then persist
  await postSlackMessage(channelId, reply, replyThreadTs)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from("agent_messages")
    .update({
      status: "done",
      reply,
      replied_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)

  return reply
}
