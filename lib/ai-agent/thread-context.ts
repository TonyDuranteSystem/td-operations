/**
 * Hermes ↔ Claude bridge — Phase C: thread conversation context (watermark).
 *
 * dev_task: 1a0d1354 (Hermes operating agent) — Phase C (intelligence)
 *
 * When the worker processes a message that belongs to a thread, it should see
 * the conversation so far — not just the single body. buildThreadContext fetches
 * every agent_messages row for a thread_id, keeps the most recent N as detailed
 * history, and (if there are more) folds the older ones into a compact extractive
 * preamble. The result is a role-labeled block ("Antonio directed / Hermes said /
 * Claude said") suitable for prepending to the worker's prompt.
 *
 * The summary/watermark is EXTRACTIVE (deterministic, no extra LLM call) — the
 * worker is already an Anthropic call; we don't pay for a second one just to
 * compress old turns. The pure formatter (formatThreadContext) is unit-tested.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

/** Number of most-recent message rows kept as detailed history. */
export const HISTORY_WATERMARK = 20

/** Max characters of a single body/reply rendered inline (older = harder cap). */
const INLINE_MAX = 1200
const PREAMBLE_LINE_MAX = 160

export interface ThreadMessageRow {
  id: string
  sender: string
  recipient: string
  body: string | null
  reply: string | null
  created_at: string
}

export interface ThreadContext {
  threadId: string
  /** Total agent_messages rows in the thread. */
  messageCount: number
  /** How many older rows were folded into the preamble (0 if none). */
  summarizedCount: number
  /** The ready-to-prepend, role-labeled text block ("" if the thread is empty). */
  text: string
}

/** Truncate + single-line collapse a chunk of message text. */
function clip(s: string | null | undefined, max: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/**
 * Role label for the INBOUND body of a row. Hermes relays Antonio's approved
 * words (R108), so the FIRST inbound Hermes message in a thread is attributed to
 * "Antonio directed" (the originating directive); later Hermes messages are
 * "Hermes said"; anything from the worker/claude side is "Claude said".
 */
function inboundLabel(sender: string, isFirstHermes: boolean): string {
  if (sender === "claude" || sender === "worker") return "Claude said"
  if (sender === "hermes") return isFirstHermes ? "Antonio directed" : "Hermes said"
  return `${sender} said`
}

/**
 * PURE: render a chronologically-sorted set of thread rows into a role-labeled
 * context block, applying the watermark. Exported for tests.
 *
 * - rows are sorted ascending by created_at (oldest first) before formatting.
 * - the most-recent `watermark` rows are rendered in full ("recent history").
 * - any older rows are summarized into a one-line-each extractive preamble.
 * - each row contributes its inbound body AND (if present) the worker's reply.
 */
export function formatThreadContext(
  threadId: string,
  rows: ThreadMessageRow[],
  watermark: number = HISTORY_WATERMARK,
): ThreadContext {
  const sorted = [...rows].sort((a, b) => (String(a.created_at) < String(b.created_at) ? -1 : 1))
  const messageCount = sorted.length
  if (messageCount === 0) {
    return { threadId, messageCount: 0, summarizedCount: 0, text: "" }
  }

  const splitAt = Math.max(0, messageCount - watermark)
  const older = sorted.slice(0, splitAt)
  const recent = sorted.slice(splitAt)

  // Track which Hermes message is the first in the WHOLE thread so its label is
  // "Antonio directed" even if it falls into the summarized older block.
  let seenHermes = false
  const labelFor = (sender: string): string => {
    if (sender === "hermes") {
      const first = !seenHermes
      seenHermes = true
      return inboundLabel(sender, first)
    }
    return inboundLabel(sender, false)
  }

  const lines: string[] = []

  if (older.length > 0) {
    lines.push(`[Earlier in this thread — ${older.length} older message(s), summarized]`)
    for (const r of older) {
      const who = labelFor(r.sender)
      const body = clip(r.body, PREAMBLE_LINE_MAX)
      if (body) lines.push(`  • ${who}: ${body}`)
      if (r.reply) lines.push(`  • Claude said: ${clip(r.reply, PREAMBLE_LINE_MAX)}`)
    }
    lines.push("")
    lines.push(`[Recent messages — last ${recent.length}]`)
  }

  for (const r of recent) {
    const who = labelFor(r.sender)
    const body = clip(r.body, INLINE_MAX)
    if (body) lines.push(`${who}: ${body}`)
    if (r.reply) lines.push(`Claude said: ${clip(r.reply, INLINE_MAX)}`)
  }

  return {
    threadId,
    messageCount,
    summarizedCount: older.length,
    text: lines.join("\n").trim(),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

export interface BuildThreadContextOptions {
  /** Override the history watermark (most-recent rows kept in full). */
  watermark?: number
  /** Drop this message id from the context (e.g. the turn being answered now). */
  excludeMessageId?: string
}

/**
 * Fetch a thread's full conversation and build its role-labeled context block.
 * Returns an empty context (text="") when threadId is falsy or the thread has no
 * messages — callers can treat "" as "no context to prepend".
 *
 * `excludeMessageId` drops the current message from the recap so it isn't shown
 * twice (once in the context, once as the user turn the worker is answering).
 */
export async function buildThreadContext(
  threadId: string,
  opts: BuildThreadContextOptions = {},
): Promise<ThreadContext> {
  if (!threadId || typeof threadId !== "string") {
    return { threadId: String(threadId ?? ""), messageCount: 0, summarizedCount: 0, text: "" }
  }
  const { data, error } = await db()
    .from("agent_messages")
    .select("id, sender, recipient, body, reply, created_at")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true })

  if (error) throw new Error(`buildThreadContext failed: ${error.message ?? "unknown error"}`)
  let rows = (data ?? []) as ThreadMessageRow[]
  if (opts.excludeMessageId) rows = rows.filter((r) => r.id !== opts.excludeMessageId)
  return formatThreadContext(threadId, rows, opts.watermark ?? HISTORY_WATERMARK)
}
