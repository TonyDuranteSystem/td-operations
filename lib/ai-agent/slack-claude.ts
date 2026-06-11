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
import { callWorker, type CallWorkerOptions, type WorkerImageBlock } from "@/lib/ai-agent/worker-tools"
import { createThreadSummary } from "@/lib/ai-agent/thread-summaries"

/**
 * Slack context for the event currently being processed. Set by
 * processSlackEvent() immediately before callWorker(), and read by the
 * start_code_task worker tool (via dynamic import) so a queued code task carries
 * the channel + thread to post its result back to. Sequential cron processing
 * (runScan's for-await loop) keeps this accurate for the in-flight event.
 */
export let _currentSlackCtx: { channelId?: string; threadTs?: string } = {}

// Image media types the Anthropic API accepts. Slack can deliver others
// (image/heic from iPhone photos, image/svg+xml, image/bmp); passing an
// unsupported type fails the ENTIRE worker call, so we filter to these and
// silently skip the rest — the text reply still goes through.
export const SLACK_SUPPORTED_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
])

// Per-image size ceiling. base64 inflates ~33%, and very large images blow up
// the API payload, so skip anything over this both at the Slack-event filter
// (file.size) and after download (buffer length).
export const SLACK_MAX_IMAGE_BYTES = 5 * 1024 * 1024 // 5 MB

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

CODE TASKS: When Antonio asks you to implement, build, fix, or deploy something:
1. First investigate with read tools to understand what needs changing
2. Call start_code_task with detailed instructions
3. The Mac Mini runs Claude Code with full repo access
4. Say "I've queued the task — Mac Mini will handle it and report back here"

SHIPPING: When Antonio says "ship it", "deploy it", "push it", or similar:
- If you just queued a code task that's done, DON'T queue another task. The runner auto-pushes.
- If there's a local commit waiting, say "The code is committed and being pushed to production."
- "Ship" = push to production. "Do it" = implement. Don't confuse them.

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

/**
 * Replace the text of an already-posted message in place (chat.update). Used to
 * morph the "On it 👍" acknowledgment into the real answer so the thread isn't
 * cluttered with two messages. Returns false when the update fails (message too
 * old, deleted, not found, etc.) so the caller can fall back to a fresh post.
 */
export async function updateSlackMessage(
  channelId: string,
  messageTs: string,
  text: string,
): Promise<boolean> {
  const r = await slackApiCall("chat.update", { channel: channelId, ts: messageTs, text })
  if (!r.ok) console.error(`[slack-claude] chat.update failed: ${r.error}`)
  return r.ok
}

// ---------------------------------------------------------------------------
// Image attachments (Slack screenshots → multimodal content)
// ---------------------------------------------------------------------------

/** A Slack image reference stored on the agent_messages row by the webhook. */
export interface SlackImageRef {
  url: string // Slack's url_private — requires the bot token to fetch
  name?: string
  mimetype: string
  size?: number
}

/**
 * Read recent messages in a Slack thread (conversations.replies) and extract
 * any image attachments. Used when the message that mentioned Claude carries no
 * image of its own but refers to a screenshot posted EARLIER in the thread
 * ("read the screenshot"). Filters to Anthropic-supported types within the size
 * cap, same as the webhook's current-message filter. Best-effort: a missing
 * token, a non-ok response (e.g. missing `channels:history` scope), or a network
 * error returns [] (logged) so the worker still answers with text.
 */
export async function fetchThreadImages(
  channelId: string,
  threadTs: string,
  limit: number = 20,
): Promise<Array<{ url: string; name: string; mimetype: string }>> {
  const token = process.env.SLACK_BOT_TOKEN_CLAUDE
  if (!token) return []

  try {
    const res = await fetch(`https://slack.com/api/conversations.replies?channel=${channelId}&ts=${threadTs}&limit=${limit}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await res.json() as { ok: boolean; messages?: Array<{ files?: Array<{ url_private: string; name: string; mimetype: string; size: number }> }> }
    if (!data.ok || !data.messages) return []

    const images: Array<{ url: string; name: string; mimetype: string }> = []
    for (const msg of data.messages) {
      for (const file of (msg.files || [])) {
        if (SLACK_SUPPORTED_IMAGE_TYPES.has(file.mimetype) && file.size <= SLACK_MAX_IMAGE_BYTES) {
          images.push({ url: file.url_private, name: file.name, mimetype: file.mimetype })
        }
      }
    }
    return images
  } catch (err) {
    console.warn('[slack-claude] fetchThreadImages failed:', err)
    return []
  }
}

/**
 * Download Slack image attachments using the Claude bot token and convert them
 * to base64 Anthropic image blocks. Best-effort and resilient: an unsupported
 * media type, an oversized file, a 401/network failure, or a missing token all
 * skip that one image (logged) — the worker still answers with the remaining
 * images + text. Returns only the blocks that downloaded cleanly.
 */
export async function prepareSlackImages(images: SlackImageRef[]): Promise<WorkerImageBlock[]> {
  const blocks: WorkerImageBlock[] = []
  if (!images.length) return blocks

  const token = process.env.SLACK_BOT_TOKEN_CLAUDE
  if (!token) {
    console.warn("[slack-claude] SLACK_BOT_TOKEN_CLAUDE not set — skipping image attachments")
    return blocks
  }

  for (const img of images) {
    if (!SLACK_SUPPORTED_IMAGE_TYPES.has(img.mimetype)) {
      console.warn(`[slack-claude] skipping unsupported image type ${img.mimetype} (${img.name ?? "unnamed"})`)
      continue
    }
    try {
      const res = await fetch(img.url, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) {
        console.warn(`[slack-claude] image download failed (${res.status}) for ${img.name ?? img.url}`)
        continue
      }
      const buffer = Buffer.from(await res.arrayBuffer())
      // Validate the downloaded bytes are actually an image. Slack's url_private
      // returns an HTML login page (not an error status) when the bot lacks the
      // files:read scope — base64-ing that garbage and sending it fails the whole
      // Anthropic call. Check the magic bytes and skip anything that isn't a real
      // PNG/JPEG/GIF/WEBP instead.
      const firstBytes = buffer.slice(0, 4)
      const isPng = firstBytes[0] === 0x89 && firstBytes[1] === 0x50 // PNG magic bytes
      const isJpeg = firstBytes[0] === 0xff && firstBytes[1] === 0xd8 // JPEG magic bytes
      const isGif = firstBytes[0] === 0x47 && firstBytes[1] === 0x49 // GIF magic bytes
      const isWebp = buffer.length > 12 && buffer.slice(8, 12).toString() === "WEBP"
      if (!isPng && !isJpeg && !isGif && !isWebp) {
        console.warn(`[slack-claude] Downloaded file ${img.name ?? "unnamed"} is not a valid image (first bytes: ${firstBytes.toString("hex")}). Likely HTML login page — bot may need files:read scope.`)
        continue // skip this image, don't crash
      }
      if (buffer.length > SLACK_MAX_IMAGE_BYTES) {
        console.warn(`[slack-claude] skipping image ${img.name ?? "unnamed"} — ${buffer.length} bytes exceeds ${SLACK_MAX_IMAGE_BYTES}`)
        continue
      }
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: img.mimetype, data: buffer.toString("base64") },
      })
    } catch (e) {
      console.warn(`[slack-claude] failed to download image ${img.name ?? img.url}:`, e)
    }
  }

  return blocks
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
  const ackTs = ctx.slack_ack_ts as string | undefined

  if (!channelId) {
    throw new Error(`agent_messages row ${row.id} missing slack_channel_id in context_json`)
  }

  // Download any attached screenshots → base64 image blocks (best-effort).
  let imageRefs = (Array.isArray(ctx.slack_images) ? ctx.slack_images : []) as SlackImageRef[]

  // No image on the current message but we're in a thread? The referenced
  // screenshot may live in an EARLIER thread message ("read the screenshot"
  // posted before the @mention). Pull images from thread history. Best-effort.
  if (imageRefs.length === 0) {
    const threadTs = ctx.slack_thread_ts as string | undefined
    if (threadTs) {
      imageRefs = await fetchThreadImages(channelId, threadTs)
    }
  }

  const imageBlocks = imageRefs.length > 0 ? await prepareSlackImages(imageRefs) : []

  // Only add `images` to the opts when there are blocks — keeps the text-only
  // call shape identical to before (and to the Hermes/Telegram path).
  const workerOpts: CallWorkerOptions = {
    threadId: row.thread_id,
    messageId: row.id,
    systemPromptOverride: SLACK_WORKER_SYSTEM_PROMPT,
    enableCodeTasks: true,
  }
  if (imageBlocks.length > 0) workerOpts.images = imageBlocks

  // Expose this event's Slack scope to the start_code_task worker tool so a
  // queued code task knows which channel/thread to report back to.
  _currentSlackCtx = { channelId, threadTs: replyThreadTs }

  // Run the worker. If the call fails specifically because of an image the API
  // rejected (a 400 mentioning "image" — e.g. a corrupt download that slipped
  // past the magic-byte guard, or an edge media type), retry once WITHOUT the
  // images so Antonio still gets a text answer instead of silent failure. Any
  // other error (non-image, or no images attached) is re-thrown unchanged so the
  // cron marks the row failed as before.
  let reply: string
  try {
    ;({ reply } = await callWorker(row.body, workerOpts))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const isImageError = imageBlocks.length > 0 && /\b400\b/.test(msg) && /image/i.test(msg)
    if (!isImageError) throw err
    console.warn(`[slack-claude] image-related API error, retrying text-only: ${msg}`)
    const textOnlyOpts: CallWorkerOptions = {
      threadId: row.thread_id,
      messageId: row.id,
      systemPromptOverride: SLACK_WORKER_SYSTEM_PROMPT,
      enableCodeTasks: true,
    }
    ;({ reply } = await callWorker(row.body, textOnlyOpts))
  }

  // Morph the "On it 👍" acknowledgment into the answer (chat.update) so the
  // thread shows one message that transforms, not two. If there's no ack ts or
  // the update fails (message too old/deleted), fall back to a fresh post.
  let posted = false
  if (ackTs) {
    posted = await updateSlackMessage(channelId, ackTs, reply)
  }
  if (!posted) {
    await postSlackMessage(channelId, reply, replyThreadTs)
  }

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
