/**
 * search_this_chat — the WhatsApp Worker's way to read the WHOLE open chat.
 *
 * Until now the Worker was handed only the newest 30 messages pasted into its prompt and had no way to
 * look further back, so "find it in this chat" failed on any chat longer than that (Antonio, 2026-11-04:
 * the $550 closure price was message 111 of 122). This tool reads every message in the open chat —
 * voice-note transcripts and quoted replies included — and the Worker decides when to use it.
 *
 * HARD PIN, same rule as read_email_attachment: the chat comes from the SERVER (`pinnedWhatsAppChat`,
 * set by the route from the verified conversation id). The tool takes NO chat id, so the model can never
 * name another person's chat. Read-only. Everything a person wrote is escaped and flattened to one line
 * by formatMessageLine, and the result is fenced as untrusted by fenceToolResult.
 */

import type { ToolDef } from "@/lib/ai-agent/tools"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { formatLocalDate, isValidYmd, localDayStartUtc, nextYmd } from "@/lib/inbox/staff-time-zone"
import { formatMessageLine, sanitizeLabel, type WhatsAppMessageRow } from "@/lib/inbox/whatsapp-worker-context"

export interface PinnedWhatsAppChat {
  /** The open chat — set by the SERVER from the verified conversation id. The tool never takes an id. */
  groupId: string
  isGroup: boolean
  /** The staff member's IANA time zone (validated): times are printed in it and YYYY-MM-DD dates are read in it. */
  timeZone: string
}

export type ChatRow = WhatsAppMessageRow & { id: string }

export interface VoiceInfo {
  transcript: string | null
  status: string | null
  seconds: number | null
}

const PAGE_SIZE = 1000
/** A chat longer than this is searched newest-first up to the cap, and the result says so. */
export const MAX_CHAT_ROWS = 5000
const MEDIA_CHUNK = 150
export const DEFAULT_LIMIT = 25
export const MAX_LIMIT = 60
const MAX_OUTPUT_CHARS = 24000
const MAX_WORDS = 8
const SEARCH_MESSAGE_CHARS = 2500
const SEARCH_VOICE_CHARS = 6000
const UNREADABLE_MEDIA = new Set(["image", "video", "document", "sticker"])

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export const SEARCH_THIS_CHAT_TOOL: ToolDef = {
  name: "search_this_chat",
  description: [
    "Search the WHOLE WhatsApp chat that is open on screen — every message from the first to the last, including the machine transcripts of voice notes and the text of messages that were replied to.",
    "This reads only that one chat and takes no chat id. The latest messages are already shown to you in the prompt; use this when the question is about this chat and the answer may be older than that slice, or to find something by word, date or sender.",
    "Every word you give must appear in the same message (accents, capital letters and apostrophes do not matter). With no words it lists the messages in the date range instead. Dates are YYYY-MM-DD in the staff member's time zone.",
    "If the result says more matches exist, call again with the offset it gives. If nothing matches, try other words — a name, a number, the other language (this chat may be in Italian) — before concluding anything.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Words to find (all must appear in one message). Omit to list messages by date/sender only." },
      from: { type: "string", description: "Only messages written by 'us' (TD) or by 'them' (the person). Omit for both." },
      after: { type: "string", description: "Only messages on or after this date (YYYY-MM-DD)." },
      before: { type: "string", description: "Only messages on or before this date (YYYY-MM-DD)." },
      limit: { type: "number", description: `How many matching messages to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
      offset: { type: "number", description: "Skip this many matches — use the offset a previous result gives to read the next page." },
      neighbors: { type: "number", description: "Messages to show before and after each match for context (default 1, max 3)." },
    },
    required: [],
  },
}

// ── matching ─────────────────────────────────────────────────────────────────────────────────

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

/** Lower-case, accent-free, one-spaced text with the usual HTML entities and curly quotes undone — what words are matched against. */
export function normalizeForSearch(s: string): string {
  return decodeBasicEntities(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’`´]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
}

export interface ParsedSearch {
  words: string[]
  from: "us" | "them" | null
  after: string | null
  before: string | null
  limit: number
  offset: number
  neighbors: number
}

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null)

/** Reads the model's parameters. Flat result (this project compiles with strict:false, so a union would not narrow). */
export function parseSearchParams(params: Record<string, unknown>): { value?: ParsedSearch; error?: string } {
  const text = typeof params.text === "string" ? params.text.trim().slice(0, 200) : ""
  const words = normalizeForSearch(text).split(" ").filter(Boolean).slice(0, MAX_WORDS)

  const rawFrom = typeof params.from === "string" ? params.from.trim().toLowerCase() : ""
  const from: "us" | "them" | null = ["us", "td", "me", "outbound", "team"].includes(rawFrom) ? "us" : ["them", "client", "lead", "person", "inbound"].includes(rawFrom) ? "them" : null

  const date = (key: "after" | "before"): { ymd: string | null; error?: string } => {
    const v = params[key]
    if (v === undefined || v === null || (typeof v === "string" && !v.trim())) return { ymd: null }
    const s = typeof v === "string" ? v.trim() : ""
    return isValidYmd(s) ? { ymd: s } : { ymd: null, error: `"${key}" must be a real date written YYYY-MM-DD (for example 2026-09-21).` }
  }
  const after = date("after")
  const before = date("before")
  if (after.error || before.error) return { error: (after.error || before.error) as string }
  if (after.ymd && before.ymd && after.ymd > before.ymd) return { error: '"after" is later than "before" — swap them.' }

  const limitRaw = finite(params.limit)
  const offsetRaw = finite(params.offset)
  const neighborsRaw = finite(params.neighbors)
  const listing = words.length === 0 && !from
  return {
    value: {
      words,
      from,
      after: after.ymd,
      before: before.ymd,
      limit: limitRaw === null ? DEFAULT_LIMIT : Math.min(MAX_LIMIT, Math.max(1, Math.floor(limitRaw))),
      offset: offsetRaw === null ? 0 : Math.max(0, Math.floor(offsetRaw)),
      // A plain date listing already shows consecutive messages; context lines would only repeat them.
      neighbors: listing ? 0 : neighborsRaw === null ? 1 : Math.min(3, Math.max(0, Math.floor(neighborsRaw))),
    },
  }
}

const isUsDirection = (row: ChatRow): boolean => row.direction === "outbound"

function searchableText(row: ChatRow): string {
  const own = (row.content_type ?? "").toLowerCase() === "voice" ? row.voice?.transcript ?? "" : row.content_text ?? ""
  return normalizeForSearch([own, row.quoted_text ?? ""].filter(Boolean).join(" "))
}

function describeSearch(q: ParsedSearch): string {
  const parts: string[] = []
  if (q.words.length) parts.push(`words "${sanitizeLabel(q.words.join(" "), 120)}"`)
  if (q.from) parts.push(q.from === "us" ? "written by us" : "written by them")
  if (q.after) parts.push(`from ${q.after}`)
  if (q.before) parts.push(`until ${q.before}`)
  return parts.length ? parts.join(", ") : "all messages"
}

/**
 * Runs one search over an already-loaded chat (oldest → newest) and renders the answer for the model.
 * Pure — the database work is in loadChatRows — so every rule here is unit-tested without a database.
 */
export function runChatSearch(rows: ChatRow[], q: ParsedSearch, ctx: { isGroup: boolean; timeZone: string; capped?: boolean }): string {
  const tz = ctx.timeZone
  if (!rows.length) return "THIS CHAT: it has no messages."

  const afterMs = q.after ? localDayStartUtc(q.after, tz)?.getTime() ?? null : null
  const beforeMs = q.before ? localDayStartUtc(nextYmd(q.before), tz)?.getTime() ?? null : null

  const hits: number[] = []
  rows.forEach((row, i) => {
    if (q.from === "us" && !isUsDirection(row)) return
    if (q.from === "them" && isUsDirection(row)) return
    if (afterMs !== null || beforeMs !== null) {
      const at = row.created_at ? Date.parse(row.created_at) : NaN
      if (Number.isNaN(at)) return
      if (afterMs !== null && at < afterMs) return
      if (beforeMs !== null && at >= beforeMs) return
    }
    if (q.words.length) {
      const hay = searchableText(row)
      if (!q.words.every((w) => hay.includes(w))) return
    }
    hits.push(i)
  })

  const first = formatLocalDate(rows[0].created_at, tz)
  const last = formatLocalDate(rows[rows.length - 1].created_at, tz)
  const unreadableMedia = rows.filter((r) => UNREADABLE_MEDIA.has((r.content_type ?? "").toLowerCase())).length
  const voiceNoText = rows.filter((r) => (r.content_type ?? "").toLowerCase() === "voice" && !(r.voice?.transcript ?? "").trim()).length
  const header = [
    `THIS CHAT: ${rows.length} messages, ${first} to ${last} (times in ${tz}).${ctx.capped ? ` Only the newest ${MAX_CHAT_ROWS} messages were searched.` : ""}`,
    unreadableMedia || voiceNoText
      ? `Not readable here: ${unreadableMedia} photos/documents/videos; ${voiceNoText} voice notes without a transcript.`
      : "",
    `SEARCH: ${describeSearch(q)}.`,
  ]
    .filter(Boolean)
    .join("\n")

  if (!hits.length) {
    const hint = q.words.length > 1 ? " Every word must appear in the same message — try fewer words, a different spelling, or the other language (this chat may be in Italian)." : q.words.length ? " Try a different spelling, a related word, a number, or the other language (this chat may be in Italian)." : ""
    return `NO MATCH. The whole chat was searched.${hint}\n${header}`
  }
  if (q.offset >= hits.length) return `NO MORE MATCHES — the search found ${hits.length} in all.\n${header}`

  const lineOf = (i: number): string =>
    formatMessageLine(rows[i], { isGroup: ctx.isGroup, tz, maxChars: SEARCH_MESSAGE_CHARS, voiceMaxChars: SEARCH_VOICE_CHARS })

  const page = hits.slice(q.offset, q.offset + q.limit)
  const hitSet = new Set(page)
  const emitted = new Set<number>()
  const out: string[] = []
  let used = 0
  let shown = 0
  let prevEmitted = -2
  for (const hit of page) {
    const lo = Math.max(0, hit - q.neighbors)
    const hi = Math.min(rows.length - 1, hit + q.neighbors)
    const fresh: Array<{ i: number; text: string }> = []
    for (let i = lo; i <= hi; i++) {
      if (emitted.has(i)) continue
      const marker = q.neighbors > 0 ? (hitSet.has(i) ? "▶ " : "  ") : ""
      fresh.push({ i, text: `${marker}${lineOf(i)}` })
    }
    const cost = fresh.reduce((n, l) => n + l.text.length + 1, 0)
    if (shown > 0 && used + cost > MAX_OUTPUT_CHARS) break
    for (const l of fresh) {
      if (q.neighbors > 0 && l.i > prevEmitted + 1 && out.length) out.push("  …")
      out.push(l.text)
      emitted.add(l.i)
      prevEmitted = l.i
    }
    used += cost
    shown += 1
  }

  const nextOffset = q.offset + shown
  const more = hits.length - nextOffset
  return [
    header,
    `MATCHES: ${hits.length} (showing ${q.offset + 1}-${nextOffset}, oldest first).${q.neighbors > 0 ? " ▶ marks a message that matches; the other lines are the messages around it." : ""}`,
    "",
    ...out,
    ...(more > 0 ? ["", `${more} more match${more === 1 ? "" : "es"} exist — call again with offset=${nextOffset} to read them.`] : []),
  ].join("\n")
}

// ── loading ──────────────────────────────────────────────────────────────────────────────────

interface DbMessageRow {
  id: string
  direction: string | null
  sender_name: string | null
  sender_phone: string | null
  content_type: string | null
  content_text: string | null
  created_at: string | null
  metadata: unknown
}

/** The text a message replied to (`messages.metadata.quoted_body`), when there is one. */
export function quotedTextOf(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null
  const q = (metadata as Record<string, unknown>).quoted_body
  return typeof q === "string" && q.trim() ? q.trim() : null
}

/** A stored message row as the Worker reads it — with its voice transcript and quoted text attached. */
export function toChatRow(row: DbMessageRow, voice?: VoiceInfo | null): ChatRow {
  return {
    id: row.id,
    direction: row.direction,
    sender_name: row.sender_name,
    sender_phone: row.sender_phone,
    content_type: row.content_type,
    content_text: row.content_text,
    created_at: row.created_at,
    quoted_text: quotedTextOf(row.metadata),
    voice: voice ?? null,
  }
}

/** Machine transcripts of voice notes, by message id. They live in message_media, not in the message row. */
export async function loadVoiceTranscripts(messageIds: string[]): Promise<Map<string, VoiceInfo>> {
  const byId = new Map<string, VoiceInfo>()
  for (let i = 0; i < messageIds.length; i += MEDIA_CHUNK) {
    const chunk = messageIds.slice(i, i + MEDIA_CHUNK)
    const { data, error } = await db.from("message_media").select("message_id, status, transcript, duration_seconds").in("message_id", chunk)
    if (error) throw new Error(error.message ?? "voice transcript read failed")
    for (const m of (data ?? []) as Array<{ message_id: string; status: string | null; transcript: string | null; duration_seconds: number | null }>) {
      byId.set(m.message_id, { transcript: m.transcript, status: m.status, seconds: m.duration_seconds })
    }
  }
  return byId
}

/** Every message of one chat, oldest → newest, newest-first up to MAX_CHAT_ROWS. Messages staff hid from their own screen stay hidden. */
export async function loadChatRows(groupId: string): Promise<{ rows: ChatRow[]; capped: boolean }> {
  const newestFirst: DbMessageRow[] = []
  for (let from = 0; from < MAX_CHAT_ROWS; from += PAGE_SIZE) {
    const { data, error } = await db
      .from("messages")
      .select("id, direction, sender_name, sender_phone, content_type, content_text, created_at, metadata")
      .eq("group_id", groupId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(error.message ?? "messages read failed")
    const page = (data ?? []) as DbMessageRow[]
    newestFirst.push(...page)
    if (page.length < PAGE_SIZE) break
  }
  const ordered = newestFirst.reverse()
  const voice = await loadVoiceTranscripts(ordered.filter((r) => (r.content_type ?? "").toLowerCase() === "voice").map((r) => r.id))
  return { rows: ordered.map((r) => toChatRow(r, voice.get(r.id))), capped: newestFirst.length >= MAX_CHAT_ROWS }
}

/**
 * Executor for search_this_chat. `pin` comes from the server's send context — NEVER from `params`; a
 * chat id the model puts in `params` is not read anywhere.
 */
export async function searchThisChatForWorker(params: Record<string, unknown>, pin: PinnedWhatsAppChat | null | undefined): Promise<string> {
  if (!pin?.groupId) return "❌ search_this_chat is not available here: no WhatsApp chat is open for this call."
  const parsed = parseSearchParams(params ?? {})
  if (parsed.error || !parsed.value) return `❌ ${parsed.error ?? "Could not read the search parameters."}`
  try {
    const { rows, capped } = await loadChatRows(pin.groupId)
    return runChatSearch(rows, parsed.value, { isGroup: pin.isGroup, timeZone: pin.timeZone, capped })
  } catch (err) {
    console.warn("[search_this_chat] read failed:", err instanceof Error ? err.message : String(err))
    return "❌ Could not read the chat just now — try the search again."
  }
}
