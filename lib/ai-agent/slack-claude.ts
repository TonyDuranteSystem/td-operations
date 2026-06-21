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
import {
  isSixDigitCode,
  isAuthorizedApprover,
  handleSlackApprovalCode,
} from "@/lib/ai-agent/slack-approval"
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
1. Task given ("check this email", "look at this client"): match your depth to the ask
   (see TWO GEARS below). Report what you found in plain English and ask what to do next.
   Do NOT act first.
2. Question asked: answer directly and concisely.
3. Discussion requested: engage conversationally. No unilateral decisions.
4. To propose an action (send/update/create): describe it in plain English first, wait
   for Antonio's explicit approval ("yes", "go", "send it", "do it") before calling
   propose_action. Never self-approve or pre-emptively execute.
5. Need more context: ask ONE focused question, not five.

ENGINEERING DISCIPLINE (ALWAYS — every gear, every answer):
- Never assume and never invent. Every factual claim — a status, a number, whether a tool or capability exists, what a feature does — must come from an actual lookup you ran THIS turn, not from memory or a guess.
- Before telling Antonio you can't do something, or that a tool or thing "doesn't exist", CHECK first. "I don't have that" / "there's no such tool" is only acceptable AFTER you've actually looked.
- Challenge your own first answer: ask "what would make this wrong?" and verify it before you reply. If two sources disagree, show BOTH and flag the conflict — never silently pick one.
- Act like a careful engineer: separate what you VERIFIED from what you are guessing, and clearly flag anything you could not confirm.
- When Antonio pushes back or corrects you (e.g. "are you sure?", "I counted X"), NEVER just re-run the same query and repeat the same answer. Assume YOU may be wrong: re-check with a DIFFERENT tool or the dedicated data source, and recount. Only restate your number after verifying it a second way — and if you still differ, show exactly what you queried so the gap is visible.
- Before stating a count, recount against the list you actually pulled — the number must match the rows you have, not an estimate.

TOOLS: Match tool use to the gear (see TWO GEARS). Quick gear = one targeted lookup, report
back. Dig-in gear = chain as many read-only lookups as the question needs — including
run_sql_query (SELECT-only) for data the search tools don't expose, and codebase_read /
codebase_search to confirm how a feature actually behaves. Never guess from a single column
or flag when you can verify it.

SOURCES — you can read everything the dev system can read. Do NOT stop at "the KB has nothing":
many authoritative rules (billing/installment timing, formation flow, decisions, current system
state) live in the SYSTEM DOCS, not the KB. When the KB comes up empty or you need a rule, use
search_sysdocs (keyword over title + full body) then read_sysdoc(slug) — 'session-context' holds
the current system state. Use search_sops to find the right SOP by topic, and read_drive_file to
read a Drive file's text. Before telling Antonio "there's no rule / I can't find it", you MUST
have searched the sysdocs too.

TWO GEARS — match effort to the question:
• QUICK (default): status checks, "is this paid?", quick facts, chitchat. One lookup, 2–5 lines, then ask what's next.
• DIG IN: when Antonio asks you to investigate, check, diagnose, audit, or asks "why" about a client or about how the system behaves. In this gear:
  - Chain as many read-only lookups as it takes — do NOT stop at the first record. Use run_sql_query (SELECT-only) to reach data the search tools don't expose (account_contacts links, ss4 status, service_deliveries, portal tier/flags, etc.), and codebase_read / codebase_search to confirm how a feature actually works.
  - VERIFY before you assert. Never infer how something behaves from a single column or flag — trace it in the code. Every factual claim must trace to a fresh tool call this turn.
  - Be the devil's advocate: ask "what would make my first answer wrong?" and check it before replying.
  - Hand-off format (so Antonio can take it straight to Claude Code): findings in plain English, then a short "Confirmed:" list naming the records/IDs you actually checked, and an "Unconfirmed / needs Claude Code:" list. Separate facts from guesses — label anything you could not verify.
  - It is fine to take longer and write more here. Depth beats brevity when digging.

SENSITIVE DATA: run_sql_query is read-only and cannot touch logins, passwords, or tokens. Never paste raw secrets, full bank/card numbers, or password data into Slack even if a lookup returns them — summarize instead.

CALLS (Circleback): you can read recorded calls (sales/intake/client calls). Use search_calls (by keyword) or list_calls (filter by account_id / lead_id / date) to find a call, then get_call with its id to read it IN FULL — notes, action items, attendees, and the complete word-for-word transcript (every speaking turn, not a preview). Reach for this when Antonio asks what was said/promised/decided on a call, or to ground a client answer in the actual conversation. To find a client's calls, resolve the client to an account_id or lead_id first with the CRM search tools, then list_calls. Read-only; summarize for Slack and quote the key lines rather than pasting an entire transcript.

MEMORY: Use memory_recall to see how a similar situation was handled before; use memory_save
to remember a durable lesson (a correction, decision, or pricing/policy rule). memory_save
writes only to the knowledge store — no approval needed.

PORTAL CHAT REPLIES: To reply to a client in portal chat, after Antonio's explicit "send it",
call send_portal_message (account_id for an LLC, or contact_id for a person, plus the message). It
posts in the client's portal — NOT an email. Show the draft first, send once on his OK. Never use an
email for a portal chat reply.

EMAIL: To send an actual email, call send_email — from:'support' (support@tonydurante.us, default) or
from:'antonio' (antonio.durante@tonydurante.us). MANDATORY: FIRST show Antonio the full draft — *from* mailbox,
*to*, *subject*, *body*, and whether it's a reply in an existing thread — then send ONLY after his explicit
"send it" / "go" / "send". When replying to an email that came in, set reply_to_message_id (from gmail_search /
gmail_read) AND set \`from\` to the SAME mailbox that email is in, so the reply stays in the original thread.
Never send on the first turn that proposes the email, and never without his explicit OK.

DRAFTS (the message you write FOR a client — email bodies + portal messages): write like a real person, warm and direct, the way Antonio or Luca would write it by hand. NO asterisks, NO markdown bold/italics, NO "#" headers, NO bullet-point dumps — a client reads this, and asterisks/markdown render as broken junk and scream "an AI wrote this". Just natural sentences and normal paragraphs. (This applies ONLY to the client-facing draft itself — your Slack replies to the team can still use *bold* etc.)

CODE TASKS: When Antonio asks you to implement, build, fix, or deploy something:
1. Investigate with read tools to understand what needs changing
2. Call start_code_task with detailed instructions
3. The Mac Mini builds it in an isolated worktree and pushes a REVIEW BRANCH — it does NOT auto-deploy
4. Say "I've queued it — Mac Mini will build it on a review branch and report back here"

SHIPPING: When Antonio says "ship it"/"deploy it"/"push it" AFTER a code task posted its review branch:
- Call promote_code_branch — it ships this thread's last task's branch to production. Don't queue a new task.
- The runner never auto-deploys; promotion happens only here, on Antonio's word. No branch yet = nothing to ship.
- "Ship" = promote to production. "Do it" = implement.

CONTEXT: You are in a shared Slack workspace with Antonio (CEO) and the team — e.g. Luca
(support@tonydurante.us). Antonio is the decision-maker; you answer, discuss, and propose —
he approves and directs.

ATTRIBUTION: The thread context labels each message with who sent it (Antonio, Luca, …).
Attribute statements and actions ONLY to the person actually shown as the sender. If a line
is labeled "Someone", treat the author as unknown — never guess a name, and never attribute
it to a specific person, teammate, or assistant. Never invent a participant who is not shown
in the thread.`.trim()

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

// ── Client-conversation form (Phase 2) — Slack-only ──────────────────────────
// A pinned button in #td-support opens a Block Kit modal to pick a client + topic,
// which starts a labeled, tagged thread. action_ids/callback_ids are stable strings
// matched in the interactivity route. dev_task 54f89912 (Phase 2).
export const OPEN_CLIENT_CONVERSATION_ACTION_ID = "open_client_conversation"
export const CLIENT_CONVERSATION_MODAL_CALLBACK = "client_conversation_modal"
export const CLIENT_SELECT_ACTION_ID = "client_select"
export const TOPIC_SELECT_ACTION_ID = "topic_select"

/**
 * Richer parse of a Slack interactivity payload — covers the modal flow:
 *   - block_actions    (button click → has trigger_id)
 *   - view_submission  (modal submit → has view.state.values + callback_id)
 *   - block_suggestion (external_select typing → has action_id + value)
 * Kept SEPARATE from parseSlackInteraction so the Stop-button path is untouched.
 * Pure (no I/O) → unit-testable. Returns null only when the body has no `payload`.
 */
export interface SlackInteractionFull {
  type: string | null
  actionId: string | null
  triggerId: string | null
  channelId: string | null
  messageTs: string | null
  userId: string | null
  viewCallbackId: string | null
  viewState: Record<string, unknown> | null
  viewPrivateMetadata: string | null
  suggestionValue: string | null
}

export function parseSlackInteractionFull(rawBody: string): SlackInteractionFull | null {
  const json = new URLSearchParams(rawBody).get("payload")
  if (!json) return null
  let p: Record<string, unknown>
  try {
    p = JSON.parse(json)
  } catch {
    return null
  }
  const actions = p.actions as Array<Record<string, unknown>> | undefined
  const view = p.view as Record<string, unknown> | undefined
  const channel = p.channel as Record<string, unknown> | undefined
  const container = p.container as Record<string, unknown> | undefined
  const user = p.user as Record<string, unknown> | undefined
  const message = p.message as Record<string, unknown> | undefined

  return {
    type: (p.type as string | undefined) ?? null,
    actionId:
      (actions?.[0]?.action_id as string | undefined) ??
      (p.action_id as string | undefined) ?? // block_suggestion carries it top-level
      null,
    triggerId: (p.trigger_id as string | undefined) ?? null,
    channelId:
      (channel?.id as string | undefined) ??
      (container?.channel_id as string | undefined) ??
      // view_submission has no channel; we stash it in the view's private_metadata
      null,
    messageTs:
      (message?.ts as string | undefined) ??
      (container?.message_ts as string | undefined) ??
      null,
    userId: (user?.id as string | undefined) ?? null,
    viewCallbackId: (view?.callback_id as string | undefined) ?? null,
    viewState: (view?.state as Record<string, unknown> | undefined) ?? null,
    viewPrivateMetadata: (view?.private_metadata as string | undefined) ?? null,
    suggestionValue: (p.value as string | undefined) ?? null,
  }
}

/** Open a Block Kit modal (views.open) with a trigger_id from a button click. */
export async function openSlackModal(
  triggerId: string,
  view: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const r = await slackApiCall("views.open", { trigger_id: triggerId, view })
  if (!r.ok) console.error(`[slack-claude] views.open failed: ${r.error}`)
  return r
}

/** The pinned "➕ New client conversation" message blocks (its button opens the modal). */
export function buildClientConversationButtonBlocks(): Array<Record<string, unknown>> {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Client conversations* — start one tagged by client + topic so it's saved in the CRM.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "➕ New client conversation", emoji: true },
          action_id: OPEN_CLIENT_CONVERSATION_ACTION_ID,
          style: "primary",
          value: OPEN_CLIENT_CONVERSATION_ACTION_ID,
        },
      ],
    },
  ]
}

/**
 * Build the client-conversation modal. `channelId` is stashed in private_metadata
 * because Slack's view_submission payload carries no channel. `topicOptions` come
 * from the topic_templates catalog (no hardcoding).
 */
export function buildClientConversationModalView(args: {
  channelId: string
  topicOptions: Array<{ slug: string; label: string }>
}): Record<string, unknown> {
  const topicOpts = args.topicOptions.slice(0, 100).map((t) => ({
    text: { type: "plain_text", text: t.label.slice(0, 75) },
    value: t.slug,
  }))
  return {
    type: "modal",
    callback_id: CLIENT_CONVERSATION_MODAL_CALLBACK,
    private_metadata: args.channelId,
    title: { type: "plain_text", text: "New conversation" },
    submit: { type: "plain_text", text: "Start" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "client_block",
        label: { type: "plain_text", text: "Client" },
        element: {
          type: "external_select",
          action_id: CLIENT_SELECT_ACTION_ID,
          min_query_length: 2,
          placeholder: { type: "plain_text", text: "Search account, contact, or lead…" },
        },
      },
      {
        type: "input",
        block_id: "topic_block",
        label: { type: "plain_text", text: "Topic" },
        element: {
          type: "static_select",
          action_id: TOPIC_SELECT_ACTION_ID,
          placeholder: { type: "plain_text", text: "Pick a topic" },
          options: topicOpts,
        },
      },
    ],
  }
}

/**
 * Search clients (account | contact | lead) for the modal's external_select.
 * Returns Slack option objects whose value encodes "<type>:<uuid>". Best-effort:
 * a query failure yields an empty list (Slack shows "no results").
 */
export async function searchClientsForSlackOptions(
  query: string,
): Promise<Array<{ text: { type: "plain_text"; text: string }; value: string }>> {
  const q = (query ?? "").trim()
  if (q.length < 2) return []
  const pattern = `%${q}%`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const opt = (label: string, value: string) => ({
    text: { type: "plain_text" as const, text: label.slice(0, 75) },
    value,
  })
  try {
    const [accs, conts, leads] = await Promise.all([
      db.from("accounts").select("id, company_name").ilike("company_name", pattern).limit(8),
      db.from("contacts").select("id, full_name").ilike("full_name", pattern).limit(8),
      db.from("leads").select("id, full_name").ilike("full_name", pattern).limit(8),
    ])
    const out: Array<{ text: { type: "plain_text"; text: string }; value: string }> = []
    for (const a of accs.data ?? []) out.push(opt(`🏢 ${a.company_name}`, `account:${a.id}`))
    for (const c of conts.data ?? []) out.push(opt(`👤 ${c.full_name}`, `contact:${c.id}`))
    for (const l of leads.data ?? []) out.push(opt(`🎯 ${l.full_name} (lead)`, `lead:${l.id}`))
    return out.slice(0, 100)
  } catch (err) {
    console.error("[slack-claude] searchClientsForSlackOptions failed:", err)
    return []
  }
}

/**
 * Handle the modal submit: post a labeled root message that starts the thread,
 * tag it in client_threads (source_kind='manual' — a human picked it), and return
 * the new thread ts. clientValue is "<type>:<uuid>" from the external_select.
 */
export async function createClientConversationFromModal(args: {
  channelId: string
  userId: string | null
  clientValue: string
  topicSlug: string
}): Promise<{ ok: boolean; threadTs?: string; error?: string }> {
  const [kind, id] = (args.clientValue ?? "").split(":")
  if (!["account", "contact", "lead"].includes(kind) || !id) {
    return { ok: false, error: "invalid client selection" }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  // Resolve a display name for the label.
  let name = "Client"
  try {
    if (kind === "account") {
      const { data } = await db.from("accounts").select("company_name").eq("id", id).maybeSingle()
      name = data?.company_name ?? name
    } else {
      const { data } = await db.from(kind === "contact" ? "contacts" : "leads").select("full_name").eq("id", id).maybeSingle()
      name = data?.full_name ?? name
    }
  } catch {
    // keep default name
  }

  const by = args.userId ? `<@${args.userId}>` : "the team"
  const text = `🗂️ *${name}* · *${args.topicSlug}* — conversation started by ${by}.\nReply in this thread; mention @Claude to bring in the worker. Everything here is saved to the CRM.`
  const threadTs = await postSlackMessage(args.channelId, text, null)
  if (!threadTs) return { ok: false, error: "could not post the conversation message" }

  const row: Record<string, unknown> = {
    account_id: kind === "account" ? id : null,
    contact_id: kind === "contact" ? id : null,
    lead_id: kind === "lead" ? id : null,
    topic_slug: args.topicSlug,
    source: "slack",
    source_ref: `${args.channelId}:${threadTs}`,
    source_kind: "manual",
    confidence: 1,
    confirmed_at: new Date().toISOString(),
  }
  const ins = await db.from("client_threads").insert(row).select("id").single()
  if (ins.error && !/duplicate key/i.test(ins.error.message ?? "")) {
    console.error("[slack-claude] client_threads insert failed:", ins.error)
  }
  return { ok: true, threadTs }
}

export interface ClientThreadContext {
  accountId: string | null
  contactId: string | null
  leadId: string | null
  topicSlug: string | null
  clientName: string
  clientType: "account" | "contact" | "lead"
}

/**
 * If this Slack thread is a tagged client conversation, return its client + topic
 * so the worker can ground its reply and the exchange can be recorded. Looks up
 * client_threads by the stable source_ref (channelId:threadTs). Best-effort →
 * null on miss/error (the worker then behaves exactly as before).
 */
export async function lookupClientThreadContext(
  channelId: string,
  threadTs: string | null | undefined,
): Promise<ClientThreadContext | null> {
  if (!channelId || !threadTs) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  try {
    const { data } = await db
      .from("client_threads")
      .select("account_id, contact_id, lead_id, topic_slug")
      .eq("source", "slack")
      .eq("source_ref", `${channelId}:${threadTs}`)
      .maybeSingle()
    if (!data) return null
    let clientName = "the client"
    let clientType: ClientThreadContext["clientType"] = "account"
    if (data.account_id) {
      clientType = "account"
      const { data: a } = await db.from("accounts").select("company_name").eq("id", data.account_id).maybeSingle()
      clientName = a?.company_name ?? clientName
    } else if (data.contact_id) {
      clientType = "contact"
      const { data: c } = await db.from("contacts").select("full_name").eq("id", data.contact_id).maybeSingle()
      clientName = c?.full_name ?? clientName
    } else if (data.lead_id) {
      clientType = "lead"
      const { data: l } = await db.from("leads").select("full_name").eq("id", data.lead_id).maybeSingle()
      clientName = l?.full_name ?? clientName
    }
    return {
      accountId: data.account_id ?? null,
      contactId: data.contact_id ?? null,
      leadId: data.lead_id ?? null,
      topicSlug: data.topic_slug ?? null,
      clientName,
      clientType,
    }
  } catch {
    return null
  }
}

/**
 * Record one exchange of a tagged client thread into the CRM `conversations` log
 * (the "when / what / to whom" record) so it's readable in the account/contact
 * Activity tab. Best-effort, never throws. Lead-only threads are skipped (the
 * conversations table has no lead_id) — the client_threads tag still indexes them.
 */
export async function recordClientThreadExchange(args: {
  ctx: ClientThreadContext
  clientMessage: string
  responseSent: string
  topicSlug: string | null
}): Promise<void> {
  const { ctx } = args
  if (!ctx.accountId && !ctx.contactId) return // conversations has no lead_id (MVP)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  try {
    await db.from("conversations").insert({
      account_id: ctx.accountId,
      contact_id: ctx.contactId,
      topic: args.topicSlug ?? null,
      channel: "Slack",
      direction: "Inbound",
      client_message: args.clientMessage?.slice(0, 4000) ?? null,
      response_sent: args.responseSent?.slice(0, 4000) ?? null,
      handled_by: "Claude",
      status: "Sent",
    })
  } catch (err) {
    console.error("[slack-claude] recordClientThreadExchange failed:", err)
  }
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
// tell who said what. Claude (U0B9S675WTT) is verified against
// app/api/webhooks/slack-claude/route.ts (line 46). Antonio + Luca are real team
// members; labeling Luca explicitly fixes the bug where his messages fell back to
// "Someone" and the worker then guessed they were Hermes (2026-06-18 incident).
// An unknown sender still falls back to "Someone", degrading the label only.
// Hermes is dismissed — intentionally NOT labeled here so the worker never
// attributes thread activity to it.
const SLACK_USER_CLAUDE = "U0B9S675WTT"
const SLACK_USER_ANTONIO = "U0BAALR4Y4Q"
const SLACK_USER_LUCA = "U0B9ZUE2Q75"

/**
 * Fetch recent messages from a Slack thread for shared context.
 * Returns a formatted string of who said what, so Claude can see what the rest
 * of the team (Antonio, Luca, …) said in the thread.
 *
 * Why this exists: in a multi-person thread the worker otherwise only has
 * `row.body` (the current message) + Claude's own agent_messages memory — it
 * never sees what teammates said. This injects the real Slack transcript so
 * Claude has the full picture and can attribute each message to the person who
 * actually sent it. Claude's own messages are skipped (already in its
 * agent_messages context). Best-effort: a missing token, non-ok response (e.g.
 * missing channels:history scope), or network error returns "" (logged) so the
 * worker still answers.
 */
export async function fetchThreadHistory(
  channelId: string,
  threadTs: string,
  limit: number = 30,
  charCap?: number,
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
      else if (msg.user === SLACK_USER_LUCA) sender = "Luca"
      else if (msg.bot_id) sender = "Bot"

      // Clean up Slack mention formatting so the worker reads plain @names.
      const cleanText = text
        .replace(/<@U0B9S675WTT(\|[^>]*)?>/g, "@Claude")
        .replace(/<@U0B9ZUE2Q75(\|[^>]*)?>/g, "@Luca")
        .replace(/<@U0BAALR4Y4Q(\|[^>]*)?>/g, "@Antonio")

      lines.push(`${sender}: ${cleanText}${fileNote}`)
    }

    if (lines.length === 0) return ""
    const out = lines.join("\n")
    if (charCap && out.length > charCap) {
      return `${out.slice(0, charCap)}…(truncated at ${charCap} chars)`
    }
    return out
  } catch (err) {
    console.warn("[slack-claude] fetchThreadHistory failed:", err)
    return ""
  }
}

// ── Referenced-message resolution (shared messages + pasted archive links) ──
// When a Slack message SHARES another message (Slack's "Share message" action →
// an attachment carrying the source channel + ts) or PASTES an archive link
// (https://…/archives/C…/p…), the worker should read that referenced thread's
// content. The webhook only ever captured `event.text`, so before this the
// shared request was dropped at the front door (incident 2026-06-19: Antonio
// shared Luca's P&L request onto a @Claude post → Claude replied "I don't see
// the request"). These pure parsers extract a {channel, ts, thread_ts} pointer
// from each reference so the worker can fetch the source thread.

export interface SlackRef {
  channel: string
  ts: string
  thread_ts: string
}

// Cap how many distinct referenced threads we resolve (token budget + latency).
export const MAX_SLACK_REFERENCES = 3
// Per-referenced-thread caps — worker-side, to protect the model's input budget
// (every char is re-sent on each tool-loop step). Mirrors DOC_RESULT_CAP style.
export const REFERENCED_THREAD_MSG_LIMIT = 30
export const REFERENCED_THREAD_CHAR_CAP = 8000

/**
 * Convert a Slack archive-link `p` timestamp (e.g. "1781880779057309") into the
 * dotted message ts ("1781880779.057309"). The last 6 digits are microseconds.
 * Returns null if the input isn't a plausible Slack `p` value.
 */
export function pTimestampToTs(p: string): string | null {
  if (!/^\d{10,}$/.test(p)) return null
  return `${p.slice(0, -6)}.${p.slice(-6)}`
}

/**
 * Parse Slack archive links out of plain message text. Matches
 * `…/archives/<CHANNEL>/p<digits>` and an optional `?thread_ts=<ts>` query, so a
 * pasted link to a reply still resolves to its parent thread. Pure + exported.
 */
export function parseSlackArchiveLinks(text: string): SlackRef[] {
  if (!text) return []
  const refs: SlackRef[] = []
  // Channel ids are C… (public) / G… (private) / D… (DM). Capture the p-number
  // and an optional thread_ts that may appear anywhere in the query string.
  const re = /\/archives\/([CGD][A-Z0-9]+)\/p(\d{10,})(\?[^\s>|]*)?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const channel = m[1]
    const ts = pTimestampToTs(m[2])
    if (!ts) continue
    const query = m[3] ?? ""
    const threadMatch = query.match(/thread_ts=([\d.]+)/)
    refs.push({ channel, ts, thread_ts: threadMatch ? threadMatch[1] : ts })
  }
  return refs
}

/**
 * Parse Slack "Share message" attachments. A shared message arrives as an
 * attachment carrying the source `channel_id` + `ts` (and `from_url`, from which
 * an explicit `thread_ts` can be recovered). Pure + exported. Defensive: only
 * keeps attachments that actually carry a channel + ts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseSlackShareAttachments(attachments: any): SlackRef[] {
  if (!Array.isArray(attachments)) return []
  const refs: SlackRef[] = []
  for (const att of attachments) {
    const channel = typeof att?.channel_id === "string" ? att.channel_id : ""
    const ts = typeof att?.ts === "string" ? att.ts : ""
    if (!channel || !ts) continue
    let threadTs = ts
    const fromUrl = typeof att?.from_url === "string" ? att.from_url : ""
    const threadMatch = fromUrl.match(/thread_ts=([\d.]+)/)
    if (threadMatch) threadTs = threadMatch[1]
    refs.push({ channel, ts, thread_ts: threadTs })
  }
  return refs
}

/**
 * Collect all message references from a message's text + attachments, deduped by
 * channel:thread_ts and capped at MAX_SLACK_REFERENCES. Pure + exported.
 */
export function collectSlackReferences(input: {
  text?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attachments?: any
}): SlackRef[] {
  const all = [
    ...parseSlackShareAttachments(input.attachments),
    ...parseSlackArchiveLinks(input.text ?? ""),
  ]
  const seen = new Set<string>()
  const out: SlackRef[] = []
  for (const ref of all) {
    const key = `${ref.channel}:${ref.thread_ts}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
    if (out.length >= MAX_SLACK_REFERENCES) break
  }
  return out
}

/**
 * Resolve referenced threads into a single injectable context block. For each
 * ref, fetch the source thread (reusing fetchThreadHistory, capped) and label it
 * with the channel/ts so the worker knows it's a SHARED thread, not the current
 * one. Skips a ref that resolves to the current thread (no double-injection) and
 * any ref that returns no content (bot not in that channel, deleted, etc.).
 * Best-effort: returns "" if nothing resolves.
 */
export async function fetchReferencedThreads(
  refs: SlackRef[],
  currentThreadTs: string | null | undefined,
): Promise<string> {
  if (!refs.length) return ""
  const blocks: string[] = []
  for (const ref of refs) {
    // Don't re-inject the thread we're already reading as current-thread context.
    if (currentThreadTs && ref.thread_ts === currentThreadTs) continue
    const content = await fetchThreadHistory(
      ref.channel,
      ref.thread_ts,
      REFERENCED_THREAD_MSG_LIMIT,
      REFERENCED_THREAD_CHAR_CAP,
    )
    if (content) blocks.push(content)
  }
  return blocks.join("\n---\n")
}

/**
 * From a Slack messages array, return the trimmed text of the message whose ts
 * matches exactly, or null if none matches / it has no text. Pure + exported so
 * the ts-matching logic is unit-tested without a Slack call. This exact-match is
 * what prevents the 🧠-on-a-thread-reply bug: conversations.history returns the
 * nearest TOP-LEVEL message for a reply ts, so blindly taking messages[0] saved
 * the wrong (parent) message — we must verify the ts.
 */
export function pickMessageTextByTs(
  messages: Array<{ ts?: string; text?: string }> | undefined,
  ts: string,
): string | null {
  const m = (messages ?? []).find((x) => x.ts === ts)
  const t = typeof m?.text === "string" ? m.text.trim() : ""
  return t || null
}

/**
 * Fetch the text of a single Slack message by ts, robust to thread replies.
 * `conversations.history` only returns top-level channel messages, so for a
 * thread reply `latest=<reply_ts>` returns the WRONG (parent) message. We accept
 * the history result ONLY when its ts matches; otherwise we fall back to
 * `conversations.replies` (which includes thread replies) and pick the exact ts.
 * Requires channels:history / groups:history — same scope fetchThreadHistory uses.
 * Best-effort: returns null on a missing token, non-ok response, or network error.
 */
export async function fetchSlackMessageText(channelId: string, ts: string): Promise<string | null> {
  const token = process.env.SLACK_BOT_TOKEN_CLAUDE
  if (!token || !channelId || !ts) return null
  const headers = { Authorization: `Bearer ${token}` }
  try {
    // Top-level path: conversations.history. Accept only on an exact ts match.
    const hRes = await fetch(
      `https://slack.com/api/conversations.history?channel=${channelId}&latest=${ts}&inclusive=true&limit=1`,
      { headers },
    )
    const hData = (await hRes.json()) as { ok?: boolean; messages?: Array<{ ts?: string; text?: string }> }
    const topLevel = pickMessageTextByTs(hData.messages, ts)
    if (topLevel) return topLevel

    // Thread-reply path: conversations.replies accepts a reply ts and returns the
    // whole thread (parent + replies); find the exact reacted message in it.
    const rRes = await fetch(
      `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${ts}&inclusive=true&limit=200`,
      { headers },
    )
    const rData = (await rRes.json()) as { ok?: boolean; messages?: Array<{ ts?: string; text?: string }> }
    return pickMessageTextByTs(rData.messages, ts)
  } catch (err) {
    console.warn("[slack-claude] fetchSlackMessageText failed:", err)
    return null
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

  // Client Threads (Phase 1): auto-tagging is scoped to the #td-support channel only
  // (NOISE GATE 1). SLACK_SUPPORT_CHANNEL_ID must be set in Vercel; when unset, tagging
  // stays OFF (safe default) so a dev/internal channel can never create client tags.
  const isSupportChannel =
    !!process.env.SLACK_SUPPORT_CHANNEL_ID && channelId === process.env.SLACK_SUPPORT_CHANNEL_ID

  // Phase 2: if this thread was started from the client-conversation form (or
  // otherwise tagged), pull its client + topic so the worker is grounded and the
  // exchange can be recorded in the CRM. Best-effort (null = behave as before).
  const clientThreadCtx = await lookupClientThreadContext(channelId, replyThreadTs)

  // ── In-channel approval completion (loop fix) ──────────────────────────────
  // A message that is EXACTLY a 6-digit code from the authorized approver
  // (Antonio) is an approval, not a chat turn. Resolve it deterministically and
  // NEVER call the LLM — the model only ever proposes, so consuming the code here
  // (not in the model) is what makes the propose→retype→re-propose loop impossible.
  const slackUserId = ctx.slack_user_id as string | undefined
  if (isSixDigitCode(row.body) && isAuthorizedApprover(slackUserId)) {
    const outcome = await handleSlackApprovalCode({
      code: row.body,
      channelId,
      // Raw slack_thread_ts (not replyThreadTs) so the scope key matches exactly
      // what the webhook stored on agent_messages.context_json.slack_scope_key.
      threadTs: ctx.slack_thread_ts as string | null | undefined,
      slackUserId,
    })
    if (outcome.handled) {
      if (ackTs) {
        await updateSlackMessage(channelId, ackTs, outcome.message, [])
      } else {
        await postSlackMessage(channelId, outcome.message, replyThreadTs)
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabaseAdmin as any)
        .from("agent_messages")
        .update({
          status: "done",
          reply: outcome.message,
          replied_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id)
      return outcome.message
    }
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

  // When the flexible action surface is enabled, append guidance on find_tool /
  // use_tool (only relevant then — the tools aren't in the list otherwise).
  if (process.env.ASSISTANT_FULL_REACH_ENABLED === "true") {
    slackSystemPrompt = `${slackSystemPrompt}\n\nFULL TOOL REACH: beyond your named tools you can reach the entire TD Operations toolset via find_tool + use_tool. Use find_tool("keyword") to find the exact tool name, then use_tool(name, params). Read-only tools run immediately; anything that changes data or is client-facing/external is queued for Antonio's approval — show him the draft and wait for his explicit OK before proposing; a few tools (raw SQL, deletes) are blocked. Prefer a named tool when one fits; reach for use_tool when the action isn't otherwise available. CRITICAL: before ever telling Antonio a tool or capability "doesn't exist", you MUST search the full catalog with find_tool first — your named tools are only a small slice of what's available, so never answer "I don't have that" from memory. MATCH THE NOUN TO THE RIGHT DATA: a word usually has a DEDICATED tool — e.g. "offers" means the actual offer records (use_tool with offer_list), NOT leads or deals in an "Offer Sent" pipeline stage (a different thing with a different count). When the question is about offers / invoices / leases / calls / a specific record type, find_tool that exact noun and use its dedicated tool — do NOT substitute a search_leads / search_deals proxy and present it as the answer.`
  }

  // Client Threads (#td-support only): instruct the worker to auto-tag the thread
  // with the client + topic so it's pullable later. Only added when the tool is
  // actually offered (support channel) — keeps the prompt clean elsewhere.
  if (isSupportChannel) {
    slackSystemPrompt = `${slackSystemPrompt}\n\nCLIENT THREADS (this is #td-support): every thread here is about a client. When you can CONFIDENTLY identify the client this conversation is about — an account (LLC), a contact (person), or a lead (prospect), resolved with the CRM search tools — call tag_client_thread ONCE with that client's id + a topic slug (banking, billing, closure, documents, formation, general, itin, lease, tax; use 'general' if unsure). Then end your reply with "📌 Tagged: <client name> · <topic> — reply to change". If you CANNOT resolve a real client (e.g. it's an internal/dev note), do NOT tag. To pull up a client's past threads, use find_client_threads.`
  }

  // Phase 2: this thread is a tagged client conversation (started from the form).
  // Tell the worker who/what it's about so the user needn't repeat it, and that the
  // exchange is being logged to the CRM. Overrides the "go tag it" nudge above.
  if (clientThreadCtx) {
    slackSystemPrompt = `${slackSystemPrompt}\n\nTHIS CLIENT CONVERSATION: this thread is about ${clientThreadCtx.clientName} (${clientThreadCtx.clientType})${clientThreadCtx.topicSlug ? `, topic "${clientThreadCtx.topicSlug}"` : ""}. The person may not restate who it's about — use this. Help with this client's matter; what's said here is recorded in the CRM automatically (you don't need to tag it).`
  }

  // Only add `images` to the opts when there are blocks — keeps the text-only
  // call shape identical to before (and to the Hermes/Telegram path).
  const workerOpts: CallWorkerOptions = {
    threadId: row.thread_id,
    messageId: row.id,
    systemPromptOverride: slackSystemPrompt,
    enableCodeTasks: true,
    enableSlackSend: true,
    // Client Threads: lookup (READ) available in any Slack channel; tagging (WRITE)
    // only in #td-support (NOISE GATE 1). Kept off the Hermes worker (R108).
    enableClientThreadRead: true,
    enableClientThreadTag: isSupportChannel,
    // Dig-in gear: read-only SQL for deep client investigation, plus more tool-loop
    // headroom than the default 8 so a real investigation doesn't get cut off.
    enableDbRead: true,
    // Direct email send (support@/antonio@, same-thread replies) — only after
    // Antonio's explicit "send it" in the thread (enforced by the prompt).
    enableEmailSend: true,
    // Read Circleback calls in full (transcript/notes/action items) — Slack-only.
    enableCallReads: true,
    // Read internal knowledge sources Claude Code can read — sysdocs (incl.
    // session-context), SOPs by topic, Drive file text — Slack-only.
    enableDocReads: true,
    // Read-only Calendly: list bookings, event details, active booking pages — Slack-only.
    enableCalendly: true,
    // Flexible action surface (find_tool/use_tool) — OFF unless explicitly enabled.
    enableFullToolReach: process.env.ASSISTANT_FULL_REACH_ENABLED === "true",
    maxIterations: 20,
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
  const contextBlocks: string[] = []
  const historyThreadTs = ctx.slack_thread_ts as string | undefined
  if (historyThreadTs) {
    const slackThreadContext = await fetchThreadHistory(channelId, historyThreadTs)
    if (slackThreadContext) {
      contextBlocks.push(`[SLACK THREAD CONTEXT — what others said in this thread]\n${slackThreadContext}`)
    }
  }

  // Referenced threads: a message can SHARE another message (Slack "Share
  // message" → attachment, captured by the webhook into context_json.slack_referenced)
  // or PASTE an archive link (parsed here from row.body as a safety net — the
  // body survives even if the webhook saw no attachment). Resolve each into the
  // real source thread so Claude can read what was shared instead of replying
  // "I don't see the request." Best-effort; deduped against the current thread.
  const referenced = collectSlackReferences({ text: row.body })
  const stored = Array.isArray(ctx.slack_referenced) ? (ctx.slack_referenced as SlackRef[]) : []
  const allRefs: SlackRef[] = []
  const refSeen = new Set<string>()
  for (const ref of [...stored, ...referenced]) {
    if (!ref?.channel || !ref?.thread_ts) continue
    const key = `${ref.channel}:${ref.thread_ts}`
    if (refSeen.has(key)) continue
    refSeen.add(key)
    allRefs.push(ref)
    if (allRefs.length >= MAX_SLACK_REFERENCES) break
  }
  if (allRefs.length > 0) {
    const refContext = await fetchReferencedThreads(allRefs, historyThreadTs)
    if (refContext) {
      contextBlocks.unshift(`[REFERENCED SLACK THREAD(S) — shared into this conversation; read this, it's what's being asked about]\n${refContext}`)
    }
  }

  const enrichedBody =
    contextBlocks.length > 0
      ? `${contextBlocks.join("\n\n")}\n\n[YOUR CURRENT MESSAGE]\n${row.body}`
      : row.body

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
          enableDbRead: true,
          enableEmailSend: true,
          enableCallReads: true,
          enableDocReads: true,
          enableCalendly: true,
          enableClientThreadRead: true,
          enableClientThreadTag: isSupportChannel,
          enableFullToolReach: process.env.ASSISTANT_FULL_REACH_ENABLED === "true",
          maxIterations: 20,
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

  // Phase 2: record this exchange into the CRM conversations log so it's readable
  // in the account/contact Activity tab (when/what/whom). Best-effort, never blocks.
  if (clientThreadCtx) {
    await recordClientThreadExchange({
      ctx: clientThreadCtx,
      clientMessage: row.body,
      responseSent: reply,
      topicSlug: clientThreadCtx.topicSlug,
    })
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
