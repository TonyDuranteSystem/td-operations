/**
 * CRM replies on the self-hosted WhatsApp link — pure helpers (no I/O, unit-tested).
 *
 * The rules live in the database (wabridge_enqueue_reply); this file only turns its answer into an HTTP status and screen wording,
 * and always fails CLOSED: anything the database returns that we cannot read is treated as a refusal, never as a queued message.
 * Antonio 2026-09-25: messages carry no personal name — every outbound CRM reply is labelled "TD Team".
 */

import { HEARTBEAT_MAX_SKEW_MS } from "./wabridge-health"

export const OUTBOX_TEAM_LABEL = "TD Team"

/** Every value wa_outbox.status may hold — registered against the database CHECK in lib/db-contract.ts. */
export const OUTBOX_STATUSES = ["shadow", "queued", "sent", "failed", "unknown"] as const
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number]
const STATUSES: readonly string[] = OUTBOX_STATUSES

export type EnqueueResult =
  | { ok: true; id: string; status: OutboxStatus; duplicate: boolean }
  | { ok: false; code: string; message: string }

const GENERIC_REFUSAL: EnqueueResult = {
  ok: false,
  code: "unreadable",
  message: "Could not queue the message — please try again, or reply from the phone.",
}

/** Read the enqueue function's jsonb answer. Anything unexpected = a refusal (never a false "queued"). */
export function parseEnqueueResult(data: unknown): EnqueueResult {
  if (typeof data !== "object" || data === null) return GENERIC_REFUSAL
  const d = data as Record<string, unknown>
  if (d.ok === true) {
    if (typeof d.id !== "string" || typeof d.status !== "string" || !STATUSES.includes(d.status)) return GENERIC_REFUSAL
    return { ok: true, id: d.id, status: d.status as OutboxStatus, duplicate: d.duplicate === true }
  }
  if (d.ok === false && typeof d.code === "string" && typeof d.message === "string") {
    return { ok: false, code: d.code, message: d.message }
  }
  return GENERIC_REFUSAL
}

/** HTTP status for a refusal: the person did something the rules do not allow (409), sent bad input (400), or it is not there (404). */
export function refusalHttpStatus(code: string): number {
  switch (code) {
    case "paused":
    case "no_inbound":
    case "not_allowed":
    case "inactive":
    case "not_one_to_one":
    case "not_wabridge":
      return 409
    case "empty":
    case "too_long":
    case "bad_request":
      return 400
    case "not_found":
      return 404
    default:
      return 500
  }
}

export interface OutboxStatusView {
  label: string
  /** neutral = informational, warn = needs a look, bad = failed */
  tone: "neutral" | "warn" | "bad"
}

/** Wording for the per-message status pill. `sent` is not shown: a sent message is an ordinary message row. */
export function describeOutboxStatus(status: string): OutboxStatusView | null {
  switch (status) {
    case "shadow":
      return { label: "Test mode — recorded, NOT sent", tone: "warn" }
    case "queued":
      return { label: "Waiting to be sent…", tone: "neutral" }
    case "sending":
      return { label: "Sending…", tone: "neutral" }
    case "unknown":
      return { label: "Not confirmed — check the phone before sending again", tone: "warn" }
    case "failed":
      return { label: "Failed — not sent", tone: "bad" }
    default:
      return null
  }
}

/** True while a message can still change state on its own (drives the faster refresh of the chat). */
export function isOutboxPending(status: string): boolean {
  return status === "queued" || status === "sending"
}

/** A claimed message is "Sending…" for this long; after that, with no result from the Mac, it is "Not confirmed" (needs a person). */
export const SENDING_WINDOW_MS = 120_000

/**
 * What the screen calls a message. The database has no 'sending' state: a claimed message is 'unknown' with a claim time.
 * Claimed less than 2 minutes ago = still being sent; older = the Mac never reported (a person must check the phone).
 */
export function outboxDisplayStatus(status: string, claimedAt: string | null | undefined, now: Date): string {
  if (status !== "unknown") return status
  const at = claimedAt ? Date.parse(claimedAt) : NaN
  if (!Number.isNaN(at) && now.getTime() - at >= 0 && now.getTime() - at < SENDING_WINDOW_MS) return "sending"
  return "unknown"
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type SendClaimParse = null | { ok: false; reason: string } | { ok: true }

/** {event:"bridge.send.claim", ts}: the Mac asks for its next message. Only a fresh signed timestamp is needed. */
export function parseSendClaim(body: unknown, now: Date): SendClaimParse {
  if (typeof body !== "object" || body === null) return null
  const b = body as Record<string, unknown>
  if (b.event !== "bridge.send.claim") return null
  if (typeof b.ts !== "number" || !Number.isFinite(b.ts) || Math.abs(now.getTime() - b.ts) > HEARTBEAT_MAX_SKEW_MS) {
    return { ok: false, reason: "stale or missing timestamp" }
  }
  return { ok: true }
}

export type SendResultParse =
  | null
  | { ok: false; reason: string }
  | { ok: true; outboxId: string; sent: boolean; messageId: string | null; error: string | null }

/**
 * {event:"bridge.send.result", ts, outbox_id, ok, message_id?, error?}: what the Mac's WhatsApp program answered.
 * `ok:true` REQUIRES a real message id (the CRM records the message from it); `ok:false` carries the program's error text.
 */
export function parseSendResult(body: unknown, now: Date): SendResultParse {
  if (typeof body !== "object" || body === null) return null
  const b = body as Record<string, unknown>
  if (b.event !== "bridge.send.result") return null
  if (typeof b.ts !== "number" || !Number.isFinite(b.ts) || Math.abs(now.getTime() - b.ts) > HEARTBEAT_MAX_SKEW_MS) {
    return { ok: false, reason: "stale or missing timestamp" }
  }
  if (typeof b.outbox_id !== "string" || !UUID_RE.test(b.outbox_id)) return { ok: false, reason: "bad outbox id" }
  if (typeof b.ok !== "boolean") return { ok: false, reason: "ok must be a boolean" }
  if (b.ok) {
    if (typeof b.message_id !== "string" || b.message_id.trim().length < 6 || b.message_id.length > 200) return { ok: false, reason: "a sent message needs its message id" }
    return { ok: true, outboxId: b.outbox_id, sent: true, messageId: b.message_id.trim(), error: null }
  }
  const error = typeof b.error === "string" ? b.error.slice(0, 500) : ""
  return { ok: true, outboxId: b.outbox_id, sent: false, messageId: null, error: error || "send failed" }
}

/** Refusal reasons from wabridge_claim_send that mean "check back later" vs "nothing will happen until a person acts". */
export function claimBackoffSeconds(reason: string | undefined): number {
  switch (reason) {
    case "paused":
    case "unhealthy":
      return 30
    case "hourly_cap":
    case "daily_cap":
    case "held":
      return 60
    default:
      return 5
  }
}

/** Every value wa_bridge_state.send_mode may hold — registered against the database CHECK in lib/db-contract.ts. */
export const SEND_MODES = ["paused", "shadow", "live"] as const
export type SendMode = (typeof SEND_MODES)[number]

/** Fail closed: anything that is not exactly 'shadow' or 'live' is paused. */
export function normalizeSendMode(value: unknown): SendMode {
  return value === "shadow" || value === "live" ? value : "paused"
}

/** The notice shown above the message box, or null when there is nothing to say. */
export function sendNotice(input: { mode: SendMode; hasInbound: boolean }): { text: string; tone: "warn" | "neutral" } | null {
  if (input.mode === "paused") return { text: "Sending from the CRM is paused — reply from the phone for now.", tone: "warn" }
  if (!input.hasInbound) {
    return { text: "You can only reply to people who have written to this number. First contact is made from the phone.", tone: "warn" }
  }
  if (input.mode === "shadow") return { text: "Test mode: replies are recorded here but NOT sent to WhatsApp.", tone: "neutral" }
  return null
}
