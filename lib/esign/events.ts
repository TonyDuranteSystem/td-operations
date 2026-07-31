/**
 * E-sign audit events — the vocabulary, the reminder-origin tag, and the ONE
 * insert helper that does not swallow its error.
 *
 * WHY THIS FILE EXISTS (the bug that created it, 2026-07-31):
 * `esign_events.event_type` is CHECK-constrained. `reminders.ts` had been
 * inserting 'expired' since 2026-06-26 — a value the constraint never allowed.
 * supabase-js RETURNS the error rather than throwing, every call site wrote
 * `await db.from("esign_events").insert(...)` and discarded it, so the insert
 * failed silently on every single expiry. Production check: 6 envelopes in
 * status 'expired', ZERO 'expired' audit rows. A legal audit trail was losing
 * events for over a month and nothing anywhere said so.
 *
 * Two defences, both here:
 *  1. EVENT_TYPES is the code-side vocabulary, registered against the live
 *     CHECK in lib/db-contract.ts — a value the database would reject now
 *     fails the pre-push gate instead of failing silently at runtime.
 *  2. insertEsignEvent() inspects the error and logs it loudly. It still does
 *     not throw: an audit write must never roll back the signature it is
 *     describing. Loud-but-non-fatal is the deliberate trade.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

/**
 * Every event type the database accepts. Must stay identical to
 * `esign_events_type_check` (migration 20260731-1830 added expired + reopened).
 */
export const EVENT_TYPES = [
  "created",
  "sent",
  "viewed",
  "signed",
  "declined",
  "completed",
  "voided",
  "reminder_sent",
  "consent_accepted",
  "expired",
  "reopened",
] as const

export type EsignEventType = (typeof EVENT_TYPES)[number]

/**
 * Where a reminder came from. Stored in `metadata.source` — NOT as its own
 * event type, so the automatic cadence can count only its own nudges.
 *
 * Without this split, a staff member clicking "Send reminder" twice would burn
 * the 2-reminder automatic budget for that signer and silently switch the
 * automatic follow-up off. Same shape as invoice_reminder_log.source.
 */
export const REMINDER_SOURCE_AUTO = "auto"
export const REMINDER_SOURCE_MANUAL = "manual"
export type ReminderSource = typeof REMINDER_SOURCE_AUTO | typeof REMINDER_SOURCE_MANUAL

/**
 * Insert one audit event. Returns true when the row actually landed.
 *
 * Deliberately non-throwing (see the file header): callers are mid-signature,
 * mid-expiry or mid-send, and an audit failure must not undo the real work. It
 * is LOUD, though — a rejected insert reaches the logs and Sentry-visible
 * console.error instead of vanishing.
 */
export async function insertEsignEvent(row: {
  envelope_id: string
  event_type: EsignEventType
  signer_id?: string | null
  ip?: string | null
  user_agent?: string | null
  metadata?: Record<string, unknown> | null
}): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { error } = await db.from("esign_events").insert({
    envelope_id: row.envelope_id,
    event_type: row.event_type,
    signer_id: row.signer_id ?? null,
    ip: row.ip ?? null,
    user_agent: row.user_agent ?? null,
    metadata: row.metadata ?? null,
  })
  if (error) {
    console.error(
      `[esign-audit] FAILED to record "${row.event_type}" for envelope ${row.envelope_id}: ${error.message}. ` +
        `The action itself succeeded — the audit trail did not. Check esign_events_type_check.`,
    )
    return false
  }
  return true
}
