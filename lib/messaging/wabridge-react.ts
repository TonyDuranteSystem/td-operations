/**
 * CRM → phone reactions on the self-hosted WhatsApp link — pure helpers (no I/O, unit-tested). Dev job 5962e46d, Release 2.
 *
 * The rules live in the database (wabridge_queue_phone_reaction / wabridge_claim_reaction / wabridge_finish_reaction in
 * scripts/migrations/20261007-1600-wabridge-crm-reactions-to-phone.sql); this file parses what the Mac sends, and turns the database's
 * answers into screen wording. It always fails CLOSED: anything unreadable is a refusal, never a false "sent".
 */

import { HEARTBEAT_MAX_SKEW_MS } from "./wabridge-health"

/**
 * The emoji the CRM may put on a customer's phone — WhatsApp's own quick reactions plus a few we use. Written WITHOUT the emoji variation
 * selector (U+FE0F). MUST equal the list inside wabridge_react_safe_emoji() in the migration (a unit test reads the SQL and compares).
 */
export const PHONE_SAFE_EMOJI: readonly string[] = ["👍", "❤", "😂", "😮", "😢", "🙏", "🤝", "👏", "✅", "🔥", "🎉", "🔝"]

/** The picker for a reaction the phone will actually receive offers exactly these (shown with the colourful heart etc.). */
export const stripVariationSelector = (emoji: string): string => emoji.replace(/️/g, "")

export function isPhoneSafeEmoji(emoji: unknown): boolean {
  return typeof emoji === "string" && PHONE_SAFE_EMOJI.includes(stripVariationSelector(emoji.trim()))
}

/** A message can only be reacted to this long after it arrived / was sent (Antonio 2026-10-07). Enforced in the database; shown here. */
export const PHONE_REACTION_MAX_AGE_MS = 60 * 60_000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─── What the Mac sends ──────────────────────────────────────────────────────────────────────────────────────────

export interface ReactClaimParse {
  ok: boolean
  reason: string | null
}

/** {event:"bridge.react.claim", ts}: the Mac asks for its next due reaction. */
export function parseReactClaim(body: unknown, now: Date): ReactClaimParse | null {
  if (typeof body !== "object" || body === null) return null
  const b = body as Record<string, unknown>
  if (b.event !== "bridge.react.claim") return null
  if (typeof b.ts !== "number" || !Number.isFinite(b.ts) || Math.abs(now.getTime() - b.ts) > HEARTBEAT_MAX_SKEW_MS) {
    return { ok: false, reason: "stale or missing timestamp" }
  }
  return { ok: true, reason: null }
}

export interface ReactResultParse {
  ok: boolean
  reason: string | null
  id: string | null
  sent: boolean
  error: string | null
}

/** {event:"bridge.react.result", ts, id, ok, error?}: what the WhatsApp program answered for one claimed reaction. */
export function parseReactResult(body: unknown, now: Date): ReactResultParse | null {
  if (typeof body !== "object" || body === null) return null
  const b = body as Record<string, unknown>
  if (b.event !== "bridge.react.result") return null
  const bad = (reason: string): ReactResultParse => ({ ok: false, reason, id: null, sent: false, error: null })
  if (typeof b.ts !== "number" || !Number.isFinite(b.ts) || Math.abs(now.getTime() - b.ts) > HEARTBEAT_MAX_SKEW_MS) return bad("stale or missing timestamp")
  if (typeof b.id !== "string" || !UUID_RE.test(b.id)) return bad("bad reaction id")
  if (typeof b.ok !== "boolean") return bad("ok must be a boolean")
  const error = typeof b.error === "string" ? b.error.slice(0, 300) : ""
  return { ok: true, reason: null, id: b.id, sent: b.ok, error: b.ok ? null : error || "the WhatsApp program refused the reaction" }
}

/** How long the Mac waits before asking again, by the reason the CRM gave for "nothing to send right now". */
export function reactBackoffSeconds(reason: string | undefined): number {
  switch (reason) {
    case "paused":
    case "unhealthy":
    case "reader_stale":
      return 20
    case "hourly_cap":
    case "daily_cap":
    case "held":
      return 30
    case "nothing_to_send":
    default:
      return 4
  }
}

// ─── What the staff screen says ──────────────────────────────────────────────────────────────────────────────────

export interface PhoneReactionQueueAnswer {
  queued: boolean
  /** why it was NOT queued ('off' = the feature is not switched on: say nothing) */
  reason: string | null
  holdSeconds: number
}

/** Read the queue function's jsonb answer. Anything unexpected = "not queued, reason unknown" (never a false "queued"). */
export function parseQueueAnswer(data: unknown): PhoneReactionQueueAnswer {
  if (typeof data !== "object" || data === null) return { queued: false, reason: "unreadable", holdSeconds: 0 }
  const d = data as Record<string, unknown>
  if (d.ok === true && d.queued === true) {
    return { queued: true, reason: null, holdSeconds: typeof d.hold_seconds === "number" ? d.hold_seconds : 10 }
  }
  if (d.ok === true && d.queued === false) return { queued: false, reason: typeof d.reason === "string" ? d.reason : "unreadable", holdSeconds: 0 }
  return { queued: false, reason: typeof d.code === "string" ? d.code : "unreadable", holdSeconds: 0 }
}

/** The message shown to staff when a reaction was saved in the CRM but NOT sent to the phone; null = say nothing. */
export function describePhoneReactionRefusal(reason: string | null | undefined): string | null {
  switch (reason) {
    case "off": // feature not switched on — the pill's tooltip already says "saved in the CRM only"
    case "unchanged": // the phone already shows this — nothing to explain
      return null
    case "not_allowed":
      return "Saved in the CRM — not sent to the phone: reactions to the phone aren't switched on for this chat yet."
    case "too_old":
      return "Saved in the CRM — not sent to the phone: the message is older than 1 hour."
    case "bad_emoji":
      return "Saved in the CRM — not sent to the phone: WhatsApp only receives the common reactions (👍 ❤️ 😂 😮 😢 🙏 🤝 👏 ✅ 🔥 🎉 🔝)."
    case "offline":
      return "Saved in the CRM — not sent to the phone: the WhatsApp link looks offline right now."
    case "no_message_id":
      return "Saved in the CRM — not sent to the phone: this message has no WhatsApp id."
    case "not_one_to_one":
    case "not_wabridge":
      return "Saved in the CRM — not sent to the phone: reactions can only go to one-to-one chats on the business line."
    default:
      return "Saved in the CRM — could not be sent to the phone."
  }
}

export interface PhoneReactionView {
  status: string
  desired: string
  error: string | null
}

/** Status line under a message's reactions. `sent` shows as the green "phone" pill instead, `cancelled` as nothing. */
export function describePhoneReactionState(v: PhoneReactionView | null | undefined): { text: string; tone: "neutral" | "bad" } | null {
  if (!v) return null
  switch (v.status) {
    case "pending":
      return { text: v.desired ? `Sending ${v.desired} to the phone in a few seconds — click it again to undo` : "Removing the reaction from the phone in a few seconds…", tone: "neutral" }
    case "sending":
      return { text: "Sending to the phone…", tone: "neutral" }
    case "failed":
      return { text: `Not sent to the phone${v.error ? ` — ${v.error}` : ""}. Click the emoji to try again.`, tone: "bad" }
    case "expired":
      return { text: "Not sent to the phone — the WhatsApp link was busy or offline for too long.", tone: "bad" }
    default:
      return null
  }
}

/** While any reaction is on its way the open chat refreshes every few seconds (drives the thread's refetch interval). */
export function isPhoneReactionInFlight(status: string | null | undefined): boolean {
  return status === "pending" || status === "sending"
}
