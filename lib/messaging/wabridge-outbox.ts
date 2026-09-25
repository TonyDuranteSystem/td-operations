/**
 * CRM replies on the self-hosted WhatsApp link — pure helpers (no I/O, unit-tested).
 *
 * The rules live in the database (wabridge_enqueue_reply); this file only turns its answer into an HTTP status and screen wording,
 * and always fails CLOSED: anything the database returns that we cannot read is treated as a refusal, never as a queued message.
 * Antonio 2026-09-25: messages carry no personal name — every outbound CRM reply is labelled "TD Team".
 */

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
  return status === "queued"
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
