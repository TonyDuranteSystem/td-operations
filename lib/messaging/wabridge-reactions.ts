/**
 * Pure helpers for WhatsApp reactions made ON THE PHONE (clients' and the business line's own) arriving in the CRM
 * (dev job 5962e46d, Release 1 — phone → CRM; Release 2 will add CRM → phone).
 *
 * No I/O. The Mac reader (scripts/wa-bridge/reactions.mjs) reads GOWA's own reaction records read-only, works out
 * what changed, and posts a signed `bridge.reactions` batch; the receiver (app/api/wa-bridge/[channelId]/route.ts)
 * validates it here, calls the database function `wabridge_apply_observed_reactions`, and answers PER ITEM so the
 * Mac advances only on explicit results (one bad item can never block the rest).
 *
 * The same rules are re-enforced inside the database function — this file just refuses obvious garbage early and
 * gives each item a stable index so results can be merged back.
 */

import { isFreshTs } from "@/lib/messaging/wabridge"

/** Most items one batch may carry (the Mac sends deltas, so this is generous). */
export const MAX_REACTION_ITEMS = 200

/** A batch's own clock (when the Mac took its snapshot) may be at most this old (a retry) or this far ahead. */
const SCAN_MAX_AGE_MS = 15 * 60_000
const SCAN_MAX_AHEAD_MS = 2 * 60_000

export type ReactionSide = "client" | "line"
export type ReactionOp = "set" | "remove"

export interface ReactionItem {
  ext_id: string
  /** digits of the other party of the 1:1 chat */
  chat: string
  side: ReactionSide
  op: ReactionOp
  /** present (non-empty) for op "set" */
  emoji?: string
  /** ISO time WhatsApp gave the reaction — display only, never used for ordering */
  reacted_at?: string
}

export type ReactionItemResult = "applied" | "noop" | "stale" | "held" | "unmatched" | "invalid"

// A plain shape (not a discriminated union): the project's non-strict tsc does not narrow unions on `ok`.
export interface ReactionEntry {
  /** index in the submitted array — results are reported against it */
  index: number
  valid: boolean
  /** set only when `valid` */
  item: ReactionItem | null
}

export interface ReactionsBatchParse {
  ok: boolean
  /** why the whole batch was refused (only when !ok) */
  reason: string | null
  /** epoch ms of the Mac's snapshot — the ONE clock all ordering uses (0 when !ok) */
  scanMs: number
  /** every submitted item keeps its index; `valid` ones go to the database, the rest are answered "invalid" */
  entries: ReactionEntry[]
}

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)

/** Remove U+FE0F so "❤" and "❤️" compare as the same emoji. */
export function stripVariationSelector(s: string): string {
  return s.replace(/️/g, "")
}

/**
 * A reaction from a stranger's phone is free text at the protocol level, so it is bounded hard: 1–32 characters, no
 * whitespace, and not plain letters/digits. A keycap (1️⃣) contains a digit but is fine; "abc" or "7" alone is not.
 * (lib/portal/reactions.ts isValidReactionEmoji must NOT be reused here — it rejects any ASCII digit, i.e. keycaps.)
 */
export function isValidObservedEmoji(value: unknown): value is string {
  if (typeof value !== "string") return false
  if (value.length === 0 || value.length > 32) return false
  if (/\s/.test(value)) return false
  if (/^[A-Za-z0-9]+$/.test(value)) return false
  return true
}

function normalizeItem(raw: unknown): ReactionItem | null {
  if (!isObj(raw)) return null
  const ext = raw.ext_id
  const chat = raw.chat
  const side = raw.side
  const op = raw.op
  if (typeof ext !== "string" || !/^[A-Za-z0-9]{4,64}$/.test(ext)) return null
  if (typeof chat !== "string" || !/^[0-9]{6,15}$/.test(chat)) return null
  if (side !== "client" && side !== "line") return null
  if (op !== "set" && op !== "remove") return null
  const item: ReactionItem = { ext_id: ext, chat, side, op }
  if (op === "set") {
    if (!isValidObservedEmoji(raw.emoji)) return null
    item.emoji = raw.emoji
  }
  if (typeof raw.reacted_at === "string" && !Number.isNaN(Date.parse(raw.reacted_at))) {
    item.reacted_at = raw.reacted_at
  }
  return item
}

const refuse = (reason: string): ReactionsBatchParse => ({ ok: false, reason, scanMs: 0, entries: [] })

export function parseReactionsBatch(body: unknown, now: Date = new Date()): ReactionsBatchParse {
  if (!isObj(body)) return refuse("not an object")
  // The signed envelope time (same rule as every other bridge.* event).
  if (!isFreshTs(body.ts, now, 10 * 60_000)) return refuse("stale or missing ts")
  const scan = body.scan_ms
  if (typeof scan !== "number" || !Number.isFinite(scan) || !Number.isInteger(scan) || scan <= 0) {
    return refuse("missing scan_ms")
  }
  if (scan < now.getTime() - SCAN_MAX_AGE_MS || scan > now.getTime() + SCAN_MAX_AHEAD_MS) {
    return refuse("scan_ms out of range")
  }
  if (!Array.isArray(body.items)) return refuse("items must be an array")
  if (body.items.length > MAX_REACTION_ITEMS) return refuse("too many items")

  const entries: ReactionEntry[] = body.items.map((raw, index) => {
    const item = normalizeItem(raw)
    return { index, valid: item !== null, item }
  })
  return { ok: true, reason: null, scanMs: scan, entries }
}

/**
 * Merge the database's answers (for the valid items only, in order) back onto every submitted index.
 * Anything the database did not answer for a valid item is reported "invalid" rather than silently dropped.
 */
export function mergeReactionResults(
  entries: Array<{ index: number; valid: boolean }>,
  dbResults: Array<{ i: number; r: string }>,
): Array<{ i: number; r: ReactionItemResult }> {
  const known = new Set<string>(["applied", "noop", "stale", "held", "unmatched", "invalid"])
  const byDbIndex = new Map<number, string>()
  for (const x of dbResults) if (typeof x?.i === "number" && typeof x?.r === "string") byDbIndex.set(x.i, x.r)
  let dbIndex = 0
  return entries.map((e) => {
    if (!e.valid) return { i: e.index, r: "invalid" as const }
    const r = byDbIndex.get(dbIndex++)
    return { i: e.index, r: (r && known.has(r) ? r : "invalid") as ReactionItemResult }
  })
}
