/**
 * CRM → phone reactions on the self-hosted WhatsApp link — pure helpers (no I/O, unit-tested). Dev job 5962e46d, Release 2.
 *
 * The rules live in the database (wabridge_react_click / wabridge_queue_phone_reaction / wabridge_claim_reaction / wabridge_finish_reaction
 * in scripts/migrations/20261007-1600-wabridge-crm-reactions-to-phone.sql); this file parses what the Mac sends, and turns the database's
 * answers into screen wording. It always fails CLOSED: anything unreadable is a refusal, never a false "sent".
 */

import { HEARTBEAT_MAX_SKEW_MS } from "./wabridge-health"

/**
 * The emoji the CRM may put on a customer's phone — WhatsApp's own quick reactions plus a few we use. Written WITHOUT the emoji variation
 * selector (U+FE0F). MUST equal the list inside wabridge_react_safe_emoji() in the migration (a unit test reads the SQL and compares).
 */
export const PHONE_SAFE_EMOJI: readonly string[] = ["👍", "❤", "😂", "😮", "😢", "🙏", "🤝", "👏", "✅", "🔥", "🎉", "🔝"]

/** The same set as shown to staff (the heart with its colour). Built from the list above so the wording can never drift from it. */
const SAFE_EMOJI_SHOWN = PHONE_SAFE_EMOJI.map((e) => (e === "❤" ? "❤️" : e)).join(" ")

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
  /** the claim number the Mac was given — an answer for an older claim is refused by the database */
  attempt: number
  /** the Mac's own clock (epoch ms) — becomes the phone element's scan_ms (ONE clock, like the phone→CRM reader) */
  ts: number
  sent: boolean
  error: string | null
}

/** {event:"bridge.react.result", ts, id, attempt, ok, error?}: what the WhatsApp program answered for one claimed reaction. */
export function parseReactResult(body: unknown, now: Date): ReactResultParse | null {
  if (typeof body !== "object" || body === null) return null
  const b = body as Record<string, unknown>
  if (b.event !== "bridge.react.result") return null
  const bad = (reason: string): ReactResultParse => ({ ok: false, reason, id: null, attempt: 0, ts: 0, sent: false, error: null })
  if (typeof b.ts !== "number" || !Number.isFinite(b.ts) || Math.abs(now.getTime() - b.ts) > HEARTBEAT_MAX_SKEW_MS) return bad("stale or missing timestamp")
  if (typeof b.id !== "string" || !UUID_RE.test(b.id)) return bad("bad reaction id")
  if (typeof b.attempt !== "number" || !Number.isInteger(b.attempt) || b.attempt < 1 || b.attempt > 100) return bad("bad claim number")
  if (typeof b.ok !== "boolean") return bad("ok must be a boolean")
  const error = typeof b.error === "string" ? b.error.slice(0, 300) : ""
  return { ok: true, reason: null, id: b.id, attempt: b.attempt, ts: Math.trunc(b.ts), sent: b.ok, error: b.ok ? null : error || "the WhatsApp program refused the reaction" }
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
    return { queued: true, reason: null, holdSeconds: typeof d.hold_seconds === "number" ? d.hold_seconds : 3 }
  }
  if (d.ok === true && d.queued === false) return { queued: false, reason: typeof d.reason === "string" ? d.reason : "unreadable", holdSeconds: 0 }
  return { queued: false, reason: typeof d.code === "string" ? d.code : "unreadable", holdSeconds: 0 }
}

/**
 * The message shown to staff when a click was saved in the CRM but NOT sent to the phone; null = say nothing.
 * `action` is what the click did: 'set' (a pick) or 'remove' (an un-pick) — the wording differs.
 */
export function describePhoneReactionRefusal(reason: string | null | undefined, action: "set" | "remove" = "set"): string | null {
  const what = action === "remove" ? "the removal was not sent to the phone" : "not sent to the phone"
  switch (reason) {
    case "off": // feature not switched on — nothing to explain
    case "unchanged": // the phone already shows this — nothing to explain
      return null
    case "not_allowed":
      return `Saved in the CRM — ${what}: reactions to the phone aren't switched on for this chat yet.`
    case "too_old":
      return `Saved in the CRM — ${what}: the message is older than 1 hour.`
    case "bad_emoji":
      return `Saved in the CRM — ${what}: WhatsApp only receives the common reactions (${SAFE_EMOJI_SHOWN}).`
    case "offline":
      return `Saved in the CRM — ${what}: the WhatsApp link looks offline right now.`
    case "sender_offline":
      return `Saved in the CRM — ${what}: the reaction sender on the Mac isn't running.`
    case "no_message_id":
      return `Saved in the CRM — ${what}: this message has no WhatsApp id.`
    case "no_inbound":
      return `Saved in the CRM — ${what}: this person hasn't written to this number yet (reactions follow the same replies-only rule).`
    case "not_one_to_one":
    case "not_wabridge":
      return `Saved in the CRM — ${what}: reactions can only go to one-to-one chats on the business line.`
    default:
      return `Saved in the CRM — ${action === "remove" ? "the removal could not be sent" : "could not be sent"} to the phone.`
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
      return { text: `Not sent to the phone${v.error ? ` — ${v.error}` : ""}. To try again, click the emoji twice.`, tone: "bad" }
    case "expired":
      return { text: "Not sent to the phone — the WhatsApp link was busy or offline for too long. To try again, click the emoji twice.", tone: "bad" }
    default:
      return null
  }
}

/** While any reaction is on its way the open chat refreshes every few seconds (drives the thread's refetch interval). */
export function isPhoneReactionInFlight(status: string | null | undefined): boolean {
  return status === "pending" || status === "sending"
}
