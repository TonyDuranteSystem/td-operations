/**
 * Pure helpers for WhatsApp delivery / read receipts on OUR outgoing messages (dev job 89d3ad80).
 *
 * GOWA emits `{event:"message.ack", timestamp, payload:{ids:[...], chat_id, receipt_type:"delivered"|"read"}}` when a
 * message reaches the person's phone or they open the chat. The receiver validates it here, then calls the database
 * function `wabridge_apply_receipts`, which writes messages.delivered_at / read_at and nothing else.
 *
 * No I/O. A receipt is cosmetic, so anything unusable is simply ignored (the receiver answers 200 — a non-2xx would
 * make GOWA retry five times for nothing).
 */

/** Most message ids one receipt may carry (WhatsApp batches; a sane ceiling keeps the SQL array small). */
export const MAX_RECEIPT_IDS = 200

export type ReceiptKind = "delivered" | "read"

export interface ParsedReceipt {
  action: "apply"
  ids: string[]
  kind: ReceiptKind
  /** ISO time WhatsApp gave the receipt (falls back to now). Never from the future. */
  at: string
}

export type ReceiptParse = ParsedReceipt | { action: "ignore"; reason: string }

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** True for a GOWA receipt event (so the receiver can route it before the message parser). */
export function isReceiptEvent(body: unknown): boolean {
  return isObj(body) && body.event === "message.ack"
}

export function parseReceiptEvent(body: unknown, now: Date = new Date()): ReceiptParse {
  if (!isObj(body) || body.event !== "message.ack") return { action: "ignore", reason: "not a receipt" }
  const p = body.payload
  if (!isObj(p)) return { action: "ignore", reason: "no payload" }

  // Groups are excluded from the bridge entirely; belt and braces so a group receipt can never be applied.
  const chat = typeof p.chat_id === "string" ? p.chat_id : ""
  if (chat.endsWith("@g.us") || chat.endsWith("@newsletter") || chat === "status@broadcast") {
    return { action: "ignore", reason: "not a one-to-one chat" }
  }

  const type = typeof p.receipt_type === "string" ? p.receipt_type.toLowerCase() : ""
  // GOWA/whatsmeow also reports "played" (voice notes) etc.; a played voice note was necessarily delivered, but we
  // only show delivered and read, so anything else is ignored rather than guessed at.
  if (type !== "delivered" && type !== "read") return { action: "ignore", reason: `receipt type ${type || "missing"}` }

  if (!Array.isArray(p.ids)) return { action: "ignore", reason: "no ids" }
  const ids = Array.from(
    new Set(p.ids.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 128)),
  ).slice(0, MAX_RECEIPT_IDS)
  if (ids.length === 0) return { action: "ignore", reason: "no usable ids" }

  const t = typeof body.timestamp === "string" ? Date.parse(body.timestamp) : NaN
  const at = Number.isNaN(t) || t > now.getTime() ? now.toISOString() : new Date(t).toISOString()

  return { action: "apply", ids, kind: type, at }
}

/** What to draw next to an outgoing message. */
export type TickState = "sent" | "delivered" | "read"

/** A message with no receipt is shown as plain "sent" only while it is fresh. Older than this with no receipt we
 *  simply do not know (receipts before this feature, or a person with receipts off), so we draw nothing rather than
 *  imply "not delivered". */
export const SENT_TICK_WINDOW_MS = 48 * 3_600_000

export function tickState(
  m: { created_at: string; delivered_at?: string | null; read_at?: string | null },
  now: Date = new Date(),
): TickState | null {
  if (m.read_at) return "read"
  if (m.delivered_at) return "delivered"
  const t = Date.parse(m.created_at)
  if (!Number.isNaN(t) && now.getTime() - t <= SENT_TICK_WINDOW_MS) return "sent"
  return null
}

/** Hover text for a tick, e.g. "Read · Oct 9, 2026, 14:05". */
export function tickLabel(
  state: TickState,
  m: { delivered_at?: string | null; read_at?: string | null },
  fmt: (iso: string) => string,
): string {
  if (state === "read" && m.read_at) return `Read · ${fmt(m.read_at)}`
  if (state === "delivered" && m.delivered_at) return `Delivered · ${fmt(m.delivered_at)}`
  return "Sent"
}
