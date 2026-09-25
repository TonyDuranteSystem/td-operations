/**
 * Pure helpers for the self-hosted WhatsApp bridge (GOWA on the Mac Mini, provider 'wabridge').
 *
 * No I/O here — the receiver route (app/api/wa-bridge/[channelId]/route.ts) verifies the
 * signature, calls parseGowaEvent, then does the database work. Kept pure so every WhatsApp
 * message shape can be unit-tested without a phone.
 *
 * What is deliberately NOT ingested (the receiver acknowledges these with 200 so GOWA does not retry):
 *  - anything that is not a one-to-one chat with a real phone number (groups, status/broadcast,
 *    newsletters, unresolved @lid identifiers) — a fake "phone number" built from such an id would
 *    open a garbage thread that no reply can ever reach (bug-hunter, 2026-09-24);
 *  - reactions, receipts, presence, edits, deletions, calls, labels — not messages;
 *  - the owner's own "message yourself" chat.
 */

import { createHmac, timingSafeEqual } from "crypto"

/** GOWA signs the raw body with HMAC-SHA256 and sends `X-Hub-Signature-256: sha256=<hex>`. */
export function verifyGowaSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header || !secret) return false
  const received = header.startsWith("sha256=") ? header.slice(7) : header
  if (!/^[0-9a-f]{64}$/i.test(received)) return false
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest()
  const got = Buffer.from(received, "hex")
  return got.length === expected.length && timingSafeEqual(got, expected)
}

export type WabridgeContentType =
  | "text" | "image" | "document" | "voice" | "video" | "location" | "contact" | "sticker" | "other"

export interface WabridgeMessage {
  externalId: string
  /** Digits only, no plus — the other party of the chat (never the owner). */
  remoteDigits: string
  direction: "inbound" | "outbound"
  senderName: string | null
  contentType: WabridgeContentType
  contentText: string
  /** ISO timestamp — WhatsApp's own send time, so an outage catch-up keeps the true order. */
  createdAt: string
  metadata: Record<string, unknown>
}

export type WabridgeParse =
  | { action: "ignore"; reason: string; /** "lid" = a real person WhatsApp identified only by a hidden id — counted, never silent. */ code?: "lid" }
  | { action: "ingest"; message: WabridgeMessage }

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null)

/** Placeholder shown in the thread when a media message has no caption (media itself is not stored yet). */
const PLACEHOLDER: Partial<Record<WabridgeContentType, string>> = {
  image: "[Photo]",
  video: "[Video]",
  voice: "[Voice note]",
  document: "[Document]",
  sticker: "[Sticker]",
  contact: "[Contact card]",
  location: "[Location]",
}

/** `393331234567:12@s.whatsapp.net` → `393331234567`; null unless it is a plain user JID. */
export function userDigitsFromJid(jid: string | null): string | null {
  if (!jid) return null
  const m = /^(\d{6,15})(?::\d+)?@(?:s\.whatsapp\.net|c\.us)$/.exec(jid.trim())
  return m ? m[1] : null
}

function detectContent(p: Json, body: string | null): { type: WabridgeContentType; text: string } | null {
  let type: WabridgeContentType | null = null
  let filename: string | null = null
  if (p.image != null) type = "image"
  else if (p.video != null || p.video_note != null) type = "video"
  else if (p.audio != null) type = "voice"
  else if (p.document != null) {
    type = "document"
    filename = isObj(p.document) ? str(p.document.filename) : null
  } else if (p.sticker != null) type = "sticker"
  else if (p.contact != null || p.contacts_array != null) type = "contact"
  else if (p.location != null || p.live_location != null) type = "location"
  else if (p.poll != null) type = "other"

  if (type === null) {
    return body ? { type: "text", text: body } : null
  }
  if (body) return { type, text: body }
  if (type === "document" && filename) return { type, text: `[Document: ${filename}]` }
  return { type, text: PLACEHOLDER[type] ?? "[Unsupported message]" }
}

function safeTimestamp(raw: unknown, now: Date): string {
  const t = typeof raw === "string" ? Date.parse(raw) : NaN
  // Reject unparseable stamps and anything more than 5 minutes in the future (clock skew / garbage).
  if (Number.isNaN(t) || t > now.getTime() + 5 * 60_000) return now.toISOString()
  return new Date(t).toISOString()
}

export function parseGowaEvent(body: unknown, now: Date = new Date()): WabridgeParse {
  if (!isObj(body)) return { action: "ignore", reason: "not an object" }
  if (body.event !== "message") return { action: "ignore", reason: `event ${String(body.event)}` }
  const p = body.payload
  if (!isObj(p)) return { action: "ignore", reason: "no payload" }

  const id = str(p.id)
  if (!id) return { action: "ignore", reason: "no message id" }

  const chatId = str(p.chat_id)
  const remote = userDigitsFromJid(chatId)
  if (!remote) {
    return {
      action: "ignore",
      reason: `not a one-to-one phone chat (${chatId ?? "no chat_id"})`,
      ...(chatId?.endsWith("@lid") ? { code: "lid" as const } : {}),
    }
  }

  const owner = userDigitsFromJid(str(body.device_id))
  if (owner && owner === remote) return { action: "ignore", reason: "message-yourself chat" }

  const fromMe = p.is_from_me === true
  const content = detectContent(p, str(p.body))
  if (!content) return { action: "ignore", reason: "no text or media" }

  const metadata: Record<string, unknown> = { source: "wabridge" }
  if (fromMe) metadata.sent_from = "phone"
  if (p.view_once === true) metadata.view_once = true
  if (p.forwarded === true) metadata.forwarded = true
  const repliedTo = str(p.replied_to_id)
  if (repliedTo) metadata.replied_to_id = repliedTo
  const quoted = str(p.quoted_body)
  if (quoted) metadata.quoted_body = quoted

  return {
    action: "ingest",
    message: {
      externalId: id,
      remoteDigits: remote,
      direction: fromMe ? "outbound" : "inbound",
      senderName: fromMe ? null : str(p.sender_display_name) ?? str(p.from_name),
      contentType: content.type,
      contentText: content.text,
      createdAt: safeTimestamp(p.timestamp, now),
      metadata,
    },
  }
}

/** True when a signed `ts` (epoch ms) is within the allowed window of now — every non-message bridge event carries one. */
export function isFreshTs(ts: unknown, now: Date, windowMs = 2 * 60_000): boolean {
  return typeof ts === "number" && Number.isFinite(ts) && Math.abs(now.getTime() - ts) <= windowMs
}

/**
 * One message of a HISTORY download (the Mac script reads GOWA's local chat store and sends neutral items
 * — engine-specific field names stay on the Mac). Same output shape as a live message, so both paths
 * share one ingest.
 */
export interface BackfillItem {
  id?: unknown
  /** digits of the other party (script derives it from the chat JID; 1:1 chats only) */
  chat?: unknown
  from_me?: unknown
  ts?: unknown // ISO timestamp from WhatsApp
  text?: unknown
  media_type?: unknown // GOWA's media_type string ("" for plain text)
  filename?: unknown
  chat_name?: unknown // the phone's saved name for this chat
}

const MEDIA_KIND: Record<string, WabridgeContentType> = {
  image: "image",
  video: "video",
  video_note: "video",
  ptv: "video",
  audio: "voice",
  ptt: "voice",
  voice: "voice",
  document: "document",
  sticker: "sticker",
  contact: "contact",
  vcard: "contact",
  location: "location",
  live_location: "location",
}

export function normalizeBackfillItem(item: unknown, now: Date = new Date()): WabridgeMessage | null {
  if (!isObj(item)) return null
  const id = str(item.id)
  const chat = typeof item.chat === "string" && /^\d{6,15}$/.test(item.chat) ? item.chat : null
  if (!id || !chat) return null
  const text = str(item.text)
  const mediaRaw = str(item.media_type)?.toLowerCase() ?? null
  const kind = mediaRaw ? (MEDIA_KIND[mediaRaw] ?? "other") : null
  const filename = str(item.filename)

  let contentType: WabridgeContentType
  let contentText: string
  if (kind) {
    contentType = kind
    contentText = text ?? (kind === "document" && filename ? `[Document: ${filename}]` : (PLACEHOLDER[kind] ?? "[Unsupported message]"))
  } else if (text) {
    contentType = "text"
    contentText = text
  } else {
    return null // nothing readable (protocol/stub rows)
  }
  const fromMe = item.from_me === true
  return {
    externalId: id,
    remoteDigits: chat,
    direction: fromMe ? "outbound" : "inbound",
    senderName: fromMe ? null : str(item.chat_name),
    contentType,
    contentText,
    createdAt: safeTimestamp(item.ts, now),
    metadata: { source: "wabridge", history: true, ...(fromMe ? { sent_from: "phone" } : {}) },
  }
}
