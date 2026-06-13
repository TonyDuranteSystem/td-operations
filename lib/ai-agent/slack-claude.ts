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

import { randomUUID, createHmac, timingSafeEqual } from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { callWorker, type CallWorkerOptions, type WorkerImageBlock } from "@/lib/ai-agent/worker-tools"
import { createThreadSummary } from "@/lib/ai-agent/thread-summaries"
import { loadRelevantTemplates, formatTemplatesForPrompt } from "@/lib/ai-agent/templates"
import { callAI } from "@/lib/portal/ai-provider"

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

// action_id of the "⏹ Stop" button attached to the "On it 👍" acknowledgment.
// The slack-interactions webhook listens for this to cancel an in-flight message
// before the worker posts its answer. Single source of truth for both the block
// builder (here) and the interactions route's action filter.
export const STOP_THINKING_ACTION_ID = "stop_thinking"

// ---------------------------------------------------------------------------
// System prompt — conversational, discuss-first, Slack-native
// ---------------------------------------------------------------------------

export const SLACK_WORKER_SYSTEM_PROMPT = `You are Claude, a member of the Tony Durante LLC operations team, present in Slack.

RESPONSE STYLE (MANDATORY):
- DEFAULT MODE: Always respond in plain, simple English. No code snippets, no file paths, no technical jargon, no developer terminology. Explain things the way you would to a business owner — focus on WHAT something means for the business, not HOW it works technically.
- TECHNICAL MODE: Only switch to technical language when the user explicitly asks for it (e.g., "give me the technical details", "show me the code", "technical report"). In technical mode, include code, file paths, and developer details.
- Always default back to plain English after a technical answer unless told otherwise.

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

MEMORY: Use memory_recall to see how a similar situation was handled before; use memory_save
to remember a durable lesson (a correction, decision, or pricing/policy rule). memory_save
writes only to the knowledge store — no approval needed.

PORTAL CHAT REPLIES: To reply to a client in portal chat, after Antonio's explicit "send it",
call send_portal_message (account_id for an LLC, or contact_id for a person, plus the message). It
posts in the client's portal — NOT an email. Show the draft first, send once on his OK. Never use an
email (propose_action / send_email) for a portal chat reply.

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
propose — he approves and directs. Hermes handles its own work independently.

SHARED THREADS: When Antonio tags both you and Hermes, you'll see Hermes's messages in
the thread context. Read them. Don't repeat what Hermes already answered. If Hermes found
something and Antonio asks you to act on it, you have the context. If Antonio says "send it"
after Hermes drafted something, acknowledge that Hermes already sent it — don't ask "to who?"`.trim()

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

/**
 * Post a message to Slack. threadTs makes it a reply in that thread. Optional
 * `blocks` post a Block Kit message (text stays as the notification/fallback);
 * used to attach the "⏹ Stop" button to the "On it 👍" acknowledgment.
 */
export async function postSlackMessage(
  channelId: string,
  text: string,
  threadTs: string | null | undefined,
  blocks?: Array<Record<string, unknown>>,
): Promise<string | null> {
  const payload: Record<string, unknown> = { channel: channelId, text }
  if (threadTs) payload.thread_ts = threadTs
  if (blocks) payload.blocks = blocks
  const r = await slackApiCall("chat.postMessage", payload)
  if (!r.ok) console.error(`[slack-claude] chat.postMessage failed: ${r.error}`)
  return r.ts ?? null
}

/**
 * Block Kit payload for the "On it 👍" acknowledgment plus a danger "⏹ Stop"
 * button. The section renders the ack text; the actions block carries the button
 * whose action_id (STOP_THINKING_ACTION_ID) the slack-interactions webhook
 * listens for. Posting the ack with these blocks is what lets Antonio cancel a
 * message while Claude is still thinking.
 */
export function buildThinkingBlocks(text: string): Array<Record<string, unknown>> {
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "⏹ Stop", emoji: true },
          action_id: STOP_THINKING_ACTION_ID,
          style: "danger",
          value: STOP_THINKING_ACTION_ID,
        },
      ],
    },
  ]
}

// "Thinking" animation shown on the "On it 👍" ack while callWorker runs. Each
// tick chat.update's the ack with the next frame (and re-attaches the Stop
// button via buildThinkingBlocks). 3 s cadence keeps well under Slack's
// chat.update rate limit (Tier 3 ~50/min) and matches the ~8-15 s worker time.
export const THINKING_TICK_MS = 3000

// Ascending-dot frames so the indicator reads as "building". Cycled by tick
// count modulo length, so a long-running call loops .→..→...→.→…
const THINKING_FRAMES = [
  "🔍 Looking into it.",
  "🔍 Looking into it..",
  "🔍 Looking into it...",
]

/**
 * Frame text for the "thinking" animation at a given tick (0-based). Pure so the
 * cycling logic is unit-testable without driving a real timer. Wraps around the
 * frame list, so any tick (including 0 or a negative) returns a valid frame.
 */
export function thinkingIndicatorText(tick: number): string {
  const len = THINKING_FRAMES.length
  return THINKING_FRAMES[((tick % len) + len) % len]
}

/**
 * Verify a Slack request signature (HMAC-SHA256 over `v0:timestamp:body`). Same
 * scheme Slack uses for both the Events API and interactive components, so the
 * slack-interactions route reuses this. Pure (secret + clock injected) so it's
 * unit-testable. Rejects requests with a missing field, an unparseable/old
 * timestamp (>5 min — replay protection), or a non-matching digest.
 */
export function verifySlackSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  secret: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!secret || !timestamp || !signature) return false
  const ts = parseInt(timestamp, 10)
  if (!Number.isFinite(ts)) return false
  if (Math.abs(nowMs / 1000 - ts) > 300) return false
  const base = `v0:${timestamp}:${rawBody}`
  const computed = `v0=${createHmac("sha256", secret).update(base).digest("hex")}`
  try {
    return timingSafeEqual(Buffer.from(computed), Buffer.from(signature))
  } catch {
    return false
  }
}

export interface SlackInteraction {
  actionId: string
  messageTs: string | null
  channelId: string | null
}

/**
 * Parse a Slack interactive-component request body. Slack sends interactivity
 * payloads as `application/x-www-form-urlencoded` with a single `payload` field
 * holding the JSON. Returns the first action's id plus the clicked message's ts
 * and channel id (needed to correlate back to the agent_messages row via
 * context_json.slack_ack_ts). Returns null when the body isn't a parseable
 * block_actions payload with at least one action.
 */
export function parseSlackInteraction(rawBody: string): SlackInteraction | null {
  const json = new URLSearchParams(rawBody).get("payload")
  if (!json) return null
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(json)
  } catch {
    return null
  }
  const actions = payload.actions as Array<Record<string, unknown>> | undefined
  const actionId = actions?.[0]?.action_id as string | undefined
  if (!actionId) return null

  const message = payload.message as Record<string, unknown> | undefined
  const container = payload.container as Record<string, unknown> | undefined
  const channel = payload.channel as Record<string, unknown> | undefined

  const messageTs =
    (message?.ts as string | undefined) ??
    (container?.message_ts as string | undefined) ??
    null
  const channelId =
    (channel?.id as string | undefined) ??
    (container?.channel_id as string | undefined) ??
    null

  return { actionId, messageTs, channelId }
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
  blocks?: Array<Record<string, unknown>>,
): Promise<boolean> {
  const payload: Record<string, unknown> = { channel: channelId, ts: messageTs, text }
  // Pass blocks: [] explicitly to CLEAR an existing Block Kit message (e.g. drop
  // the "⏹ Stop" button when morphing the ack into the answer). Omitting the arg
  // leaves blocks untouched.
  if (blocks !== undefined) payload.blocks = blocks
  const r = await slackApiCall("chat.update", payload)
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

// Known Slack user IDs, used to label thread-history lines so the worker can
// tell who said what. Claude (U0B9S675WTT) and Hermes (U0B9D3MAD9B) are verified
// against app/api/webhooks/slack-claude/route.ts (lines 46 + 201). Antonio's id
// is supplied by Antonio (his own Slack id) — an unknown sender just falls back
// to "Someone", so a wrong id degrades the label only, never the flow.
const SLACK_USER_CLAUDE = "U0B9S675WTT"
const SLACK_USER_HERMES = "U0B9D3MAD9B"
const SLACK_USER_ANTONIO = "U0BAALR4Y4Q"

/**
 * Fetch recent messages from a Slack thread for shared context.
 * Returns a formatted string of who said what, so Claude can see
 * Hermes's messages and Antonio's replies to both bots.
 *
 * Why this exists: in a thread where Antonio tags both @Claude and @Hermes, the
 * worker otherwise only has `row.body` (the current message) + Claude's own
 * agent_messages memory — it never sees what Hermes said. This injects the real
 * Slack transcript so Claude has the full picture. Claude's own messages are
 * skipped (they're already in its agent_messages context). Best-effort: a
 * missing token, non-ok response (e.g. missing channels:history scope), or
 * network error returns "" (logged) so the worker still answers.
 */
export async function fetchThreadHistory(
  channelId: string,
  threadTs: string,
  limit: number = 30,
): Promise<string> {
  const token = process.env.SLACK_BOT_TOKEN_CLAUDE
  if (!token) return ""

  try {
    const res = await fetch(
      `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${threadTs}&limit=${limit}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const data = await res.json() as {
      ok: boolean
      messages?: Array<{
        user?: string
        bot_id?: string
        text?: string
        ts?: string
        files?: Array<{ name: string }>
      }>
    }
    if (!data.ok || !data.messages) return ""

    const lines: string[] = []
    for (const msg of data.messages) {
      // Skip Claude's own messages — already in its agent_messages context.
      if (msg.user === SLACK_USER_CLAUDE) continue

      const text = (msg.text || "").trim()
      const fileNote = msg.files?.length ? ` [+${msg.files.length} file(s)]` : ""
      if (!text && !fileNote) continue

      // Determine who sent it
      let sender = "Someone"
      if (msg.user === SLACK_USER_ANTONIO) sender = "Antonio"
      else if (msg.user === SLACK_USER_HERMES) sender = "Hermes"
      else if (msg.bot_id) sender = "Bot"

      // Clean up Slack mention formatting so the worker reads plain @names.
      const cleanText = text
        .replace(/<@U0B9S675WTT(\|[^>]*)?>/g, "@Claude")
        .replace(/<@U0B9D3MAD9B(\|[^>]*)?>/g, "@Hermes")
        .replace(/<@U0BAALR4Y4Q(\|[^>]*)?>/g, "@Antonio")

      lines.push(`${sender}: ${cleanText}${fileNote}`)
    }

    if (lines.length === 0) return ""
    return lines.join("\n")
  } catch (err) {
    console.warn("[slack-claude] fetchThreadHistory failed:", err)
    return ""
  }
}

// ---------------------------------------------------------------------------
// Auto-detection of corrections (Decision Memory — Phase 5)
// ---------------------------------------------------------------------------

/**
 * When Antonio's latest message reads like a correction of a prior bot proposal,
 * persist it as a decision memory so the lesson is recalled next time a similar
 * situation comes up. Rather than regex-matching trigger phrases, we ask Haiku to
 * read the prior bot turn + Antonio's message and extract the durable business
 * lesson (or decide there is none). This catches corrections phrased in ways no
 * keyword list anticipates, and lets the model — not us — distinguish a real
 * lesson from idle chat. Best-effort and fully non-fatal: any failure (missing
 * key, AI error, parse error, insert error) is swallowed with a warn so it can
 * never break the Slack/Hermes reply path.
 *
 * Mapping onto saveDecisionMemory: the extracted `lesson` → the decision;
 * `botSaid` (the prior bot turn being corrected) → bot_said; the extracted
 * `situation` → the embedded situation used for recall; `domain` → the bucket.
 *
 * Note: saveDecisionMemory uses the camelCase param shape (botSaid/correctionType/
 * sourceType/sourceRef) — verified against lib/ai-agent/decision-memory.ts.
 */
export async function detectAndSaveCorrection(params: {
  situation: string
  currentMessage: string
  botSaid: string
  sourceType: string
  sourceRef: string
  actors?: string[]
}): Promise<void> {
  const { situation, currentMessage, botSaid, sourceType, sourceRef } = params

  // A bare "no" is too ambiguous to be a useful lesson; require some substance.
  if (!currentMessage || currentMessage.trim().length < 15) return
  // Nothing to correct if there's no prior bot proposal in context.
  if (!botSaid?.trim()) return

  try {
    // Ask Haiku to extract the business lesson (cheap, fast, JSON-only).
    const { text } = await callAI({
      systemPrompt:
        "Antonio (CEO of Tony Durante LLC) may be correcting a prior bot proposal. " +
        "Extract the durable, reusable business lesson from his message. " +
        'Return ONLY JSON: {"situation": "...", "lesson": "...", "domain": "..."} when there is a real, reusable lesson, ' +
        'or {"no_lesson": true} when the message is not a correction or carries no reusable lesson. No prose, JSON only.',
      userPrompt: `PRIOR BOT PROPOSAL:\n${botSaid.slice(0, 1000)}\n\nTHREAD CONTEXT:\n${(situation || "").slice(-1500)}\n\nANTONIO'S MESSAGE:\n${currentMessage.trim()}`,
      maxTokens: 300,
      temperature: 0,
      model: "haiku",
    })

    // Tolerant parse: strip code fences and grab the first {...} block.
    let parsed: { situation?: string; lesson?: string; domain?: string; no_lesson?: boolean } | null = null
    const match = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim().match(/\{[\s\S]*\}/)
    if (match) {
      try { parsed = JSON.parse(match[0]) } catch { parsed = null }
    }
    if (!parsed || parsed.no_lesson || !parsed.situation || !parsed.lesson) return

    const { saveDecisionMemory } = await import("./decision-memory")
    await saveDecisionMemory({
      situation: parsed.situation.slice(0, 500),
      decision: parsed.lesson.slice(0, 1000),
      botSaid: botSaid.slice(0, 300),
      correctionType: "auto_detected",
      domain: parsed.domain || undefined,
      sourceType,
      sourceRef,
      actors: params.actors ?? ["antonio", "claude"],
      tags: ["auto_correction"],
    })
  } catch (err) {
    console.warn("[slack-claude] auto-save correction failed (non-fatal):", err)
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

  // Ground the reply in approved CRM templates when the message matches one.
  // Keyword-matched against the templates / email_templates libraries; best-effort
  // (returns "" on no match), so the system prompt is unchanged when nothing fits.
  let slackSystemPrompt = SLACK_WORKER_SYSTEM_PROMPT
  try {
    const relevantTemplates = await loadRelevantTemplates(row.body, { limit: 3 })
    const templatesBlock = formatTemplatesForPrompt(relevantTemplates)
    if (templatesBlock) slackSystemPrompt = `${SLACK_WORKER_SYSTEM_PROMPT}\n\n${templatesBlock}`
  } catch (err) {
    console.warn("[slack-claude] template load failed (non-fatal):", err)
  }

  // Only add `images` to the opts when there are blocks — keeps the text-only
  // call shape identical to before (and to the Hermes/Telegram path).
  const workerOpts: CallWorkerOptions = {
    threadId: row.thread_id,
    messageId: row.id,
    systemPromptOverride: slackSystemPrompt,
    enableCodeTasks: true,
    enableSlackSend: true,
  }
  if (imageBlocks.length > 0) workerOpts.images = imageBlocks

  // Expose this event's Slack scope to the start_code_task worker tool so a
  // queued code task knows which channel/thread to report back to.
  _currentSlackCtx = { channelId, threadTs: replyThreadTs }

  // Shared-thread context: when this is a thread reply, fetch the full Slack
  // thread so Claude sees what everyone else said — including Hermes. Without
  // this the worker only has row.body + Claude's own agent_messages memory and
  // misses Hermes's messages in a thread where both bots were tagged. Gated on
  // the genuine thread ts (slack_thread_ts) — same gate as the thread-image
  // fallback above; a brand-new top-level mention has no prior thread to read.
  // Best-effort: returns "" on any failure, in which case we use row.body as-is.
  let enrichedBody = row.body
  const historyThreadTs = ctx.slack_thread_ts as string | undefined
  if (historyThreadTs) {
    const slackThreadContext = await fetchThreadHistory(channelId, historyThreadTs)
    if (slackThreadContext) {
      enrichedBody = `[SLACK THREAD CONTEXT — what others said in this thread]\n${slackThreadContext}\n\n[YOUR CURRENT MESSAGE]\n${row.body}`
    }
  }

  // Animated "thinking" indicator. While callWorker runs (a single, non-
  // interruptible API call lasting ~8-15s), cycle the "On it 👍" ack through a
  // "🔍 Looking into it…" animation so Antonio sees Claude is actively working.
  // Each tick chat.update's the SAME ack message (ackTs) and re-attaches the
  // Stop button via buildThinkingBlocks so it stays clickable. Guards:
  //   - only runs when the ack exists (ackTs set; null if the ack post failed)
  //   - re-reads the live row status each tick and stops the moment it leaves
  //     'processing' (Stop clicked → 'cancelled'), so it never clobbers the
  //     interactions webhook's "⏹ Stopped" notice nor re-adds the button
  //   - an in-flight flag skips a tick while the previous chat.update is pending
  //   - cleared in a finally so a thrown worker call can never leak the timer
  let thinkingTimer: ReturnType<typeof setInterval> | null = null
  if (ackTs) {
    let tick = 0
    let updating = false
    thinkingTimer = setInterval(() => {
      if (updating) return
      updating = true
      void (async () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: live } = await (supabaseAdmin as any)
            .from("agent_messages")
            .select("status")
            .eq("id", row.id)
            .maybeSingle()
          if (live?.status !== "processing") {
            if (thinkingTimer) clearInterval(thinkingTimer)
            return
          }
          tick += 1
          const frame = thinkingIndicatorText(tick)
          await updateSlackMessage(channelId, ackTs, frame, buildThinkingBlocks(frame))
        } catch (err) {
          console.warn("[slack-claude] thinking animation tick failed (non-fatal):", err)
        } finally {
          updating = false
        }
      })()
    }, THINKING_TICK_MS)
  }

  // Run the worker. If the call fails specifically because of an image the API
  // rejected (a 400 mentioning "image" — e.g. a corrupt download that slipped
  // past the magic-byte guard, or an edge media type), retry once WITHOUT the
  // images so Antonio still gets a text answer instead of silent failure. Any
  // other error (non-image, or no images attached) is re-thrown unchanged so the
  // cron marks the row failed as before. The thinking timer is cleared in the
  // finally so it stops regardless of success, image-retry, or rethrow.
  let reply: string
  try {
    try {
      try {
        ;({ reply } = await callWorker(enrichedBody, workerOpts))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const isImageError = imageBlocks.length > 0 && /\b400\b/.test(msg) && /image/i.test(msg)
        if (!isImageError) throw err
        console.warn(`[slack-claude] image-related API error, retrying text-only: ${msg}`)
        const textOnlyOpts: CallWorkerOptions = {
          threadId: row.thread_id,
          messageId: row.id,
          systemPromptOverride: slackSystemPrompt,
          enableCodeTasks: true,
          enableSlackSend: true,
        }
        ;({ reply } = await callWorker(enrichedBody, textOnlyOpts))
      }
    } finally {
      if (thinkingTimer) clearInterval(thinkingTimer)
    }
  } catch (err) {
    // The worker genuinely failed (a non-image error, or the text-only retry
    // also threw). The thinking animation has been cleared by the finally above,
    // but the ack is frozen on its last "🔍 Looking into it…" frame — to Antonio
    // it looks like Claude is still working forever. Replace it with a clear
    // error notice and drop the "⏹ Stop" button so he knows it failed and can
    // retry. Skip if he already clicked Stop ('cancelled') so we don't clobber
    // the "⏹ Stopped" notice. Fully best-effort — then re-throw so the cron still
    // marks the row 'failed' exactly as before.
    if (ackTs) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: liveOnError } = await (supabaseAdmin as any)
          .from("agent_messages")
          .select("status")
          .eq("id", row.id)
          .maybeSingle()
        if (liveOnError?.status !== "cancelled") {
          await updateSlackMessage(
            channelId,
            ackTs,
            "⚠️ Something went wrong on my end — try again or rephrase.",
            [],
          )
        }
      } catch (notifyErr) {
        console.warn("[slack-claude] failed to post error notice to ack (non-fatal):", notifyErr)
      }
    }
    throw err
  }

  // Cancellation check (Stop button). While callWorker was running, Antonio may
  // have clicked "⏹ Stop" — the slack-interactions webhook then set this row's
  // status to 'cancelled' AND already morphed the Slack message into the
  // "Stopped" notice. If so, don't post the (now unwanted) answer and don't flip
  // the row to done. This is the only feasible cancel point: callWorker is a
  // single API call with no interrupt, so we honor the stop here, as late as
  // possible — immediately before posting. Re-read the live status fresh.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: freshRow } = await (supabaseAdmin as any)
    .from("agent_messages")
    .select("status")
    .eq("id", row.id)
    .maybeSingle()
  if (freshRow?.status === "cancelled") {
    return reply
  }

  // Post the answer as a NEW message in the thread. A fresh post is what triggers
  // a Slack push notification on Antonio's phone — chat.update (the old in-place
  // "morph" of the "On it 👍" ack) is an edit and Slack does NOT notify on edits,
  // so he had no way to know Claude had finished. Post the answer FIRST so that if
  // the post fails we can still fall back to the ack message and never lose the reply.
  const answerTs = await postSlackMessage(channelId, reply, replyThreadTs)

  // Clean up the "On it 👍" ack now that the answer has landed as its own message.
  if (ackTs) {
    if (answerTs) {
      // Answer delivered → collapse the ack to a minimal "✅" and drop the "⏹ Stop"
      // button (blocks: []) now that processing is complete. Best-effort cleanup;
      // a failed update just leaves a harmless dead button on the ack.
      await updateSlackMessage(channelId, ackTs, "✅", [])
    } else {
      // The fresh post failed (Slack error). Fall back to the OLD behavior: morph
      // the ack into the answer so the reply still reaches Antonio (no push, but
      // not lost) and drop the Stop button.
      await updateSlackMessage(channelId, ackTs, reply, [])
    }
  }

  // Mark done, but guard on status='processing' so a Stop that lands in the tiny
  // window between the re-read above and this write can't be clobbered back to
  // done (TOCTOU-safe — same pattern as the operations-helper reviewed_at guard).
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
    .eq("status", "processing")

  // Phase 5 (Decision Memory): if Antonio's message corrects a prior Claude
  // proposal in this thread, persist the lesson. Runs AFTER the reply is posted
  // and the row marked done, so the embedding/OpenAI round-trip never delays
  // Antonio's answer. Fully best-effort — never throws into the worker path.
  try {
    if (row.thread_id) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: priorRows } = await (supabaseAdmin as any)
        .from("agent_messages")
        .select("reply")
        .eq("thread_id", row.thread_id)
        .eq("status", "done")
        .not("reply", "is", null)
        .neq("id", row.id)
        .order("created_at", { ascending: false })
        .limit(1)
      const priorBotSaid = priorRows?.[0]?.reply as string | undefined
      if (priorBotSaid) {
        await detectAndSaveCorrection({
          situation: enrichedBody,
          currentMessage: row.body,
          botSaid: priorBotSaid,
          sourceType: "slack",
          sourceRef: `${channelId}:${replyThreadTs ?? row.id}`,
          actors: ["antonio", "claude"],
        })
      }
    }
  } catch (err) {
    console.warn("[slack-claude] correction auto-detect failed (non-fatal):", err)
  }

  return reply
}
