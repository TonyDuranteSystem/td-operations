/**
 * Booking links — "Calls to check": raising a card when a booking needs a human look. The WRITER only (the Calendar tab that shows the cards is Stage 1b).
 *
 * Contract: raiseCallCheck NEVER throws and NEVER fails the webhook. But a card that cannot be saved must not vanish silently either (the same database blip that
 * made the booking's effect fail can make this insert fail): then the failure is reported as a system error AND the stored Calendly event is marked
 * review_status 'link_check', so it still shows up somewhere staff look.
 *
 * One card per (kind, dedupe_key): the key is the booking's invitee URI, so Calendly re-sending the same booking never makes a second card.
 */

import { isMissingTable } from "@/lib/booking-links/missing-table"

export const CALL_CHECK_KINDS = ["unpaid_call", "mismatch", "unknown_id", "effect_failed"] as const
export type CallCheckKind = (typeof CALL_CHECK_KINDS)[number]

export interface CallCheckInput {
  kind: CallCheckKind
  /** one card per (kind, dedupeKey) */
  dedupeKey: string
  bookingLinkId?: string | null
  leadId?: string | null
  contactId?: string | null
  eventUri?: string | null
  /** what the card shows; keep it small (the utm text of an unknown id is cut to 40 characters) */
  payload?: Record<string, unknown>
}

export interface CallCheckFallback {
  /** the webhook_events row this booking was stored in, so it can be marked for review if the card cannot be saved */
  webhookEventId?: string | null
  reportError?: (message: string, context: Record<string, unknown>) => Promise<void>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- call_checks / webhook_events: new table, untyped client
type Db = any

export const REVIEW_STATUS_LINK_CHECK = "link_check"

async function defaultReportError(message: string, context: Record<string, unknown>): Promise<void> {
  const { reportSystemError } = await import("@/lib/system-errors")
  await reportSystemError({ source: "server", route: "/api/webhooks/calendly", message, context })
}

/** Cut text that came from a visitor (an edited address) before it is stored. */
export function clip(value: unknown, max = 40): string | null {
  return typeof value === "string" && value ? value.slice(0, max) : null
}

export async function raiseCallCheck(db: Db, input: CallCheckInput, fallback: CallCheckFallback = {}): Promise<{ ok: boolean; created: boolean }> {
  let failure: string | null = null
  try {
    const { data, error } = await db
      .from("call_checks")
      .upsert(
        {
          kind: input.kind,
          dedupe_key: input.dedupeKey,
          status: "open",
          booking_link_id: input.bookingLinkId ?? null,
          lead_id: input.leadId ?? null,
          contact_id: input.contactId ?? null,
          calendly_event_uri: input.eventUri ?? null,
          payload: input.payload ?? {},
        },
        { onConflict: "kind,dedupe_key", ignoreDuplicates: true },
      )
      .select("id")
    if (!error) return { ok: true, created: Array.isArray(data) && data.length > 0 }
    failure = isMissingTable(error) ? "the call_checks table does not exist" : String(error.message ?? "insert failed")
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e)
  }

  // The card could not be saved: make sure it is still not silent.
  try {
    const report = fallback.reportError ?? defaultReportError
    await report(`A booking needs a look but its card could not be saved (${input.kind}): ${failure}`, { kind: input.kind, dedupe_key: input.dedupeKey, booking_link_id: input.bookingLinkId ?? null })
  } catch {
    /* best effort */
  }
  try {
    if (fallback.webhookEventId) await db.from("webhook_events").update({ review_status: REVIEW_STATUS_LINK_CHECK }).eq("id", fallback.webhookEventId)
  } catch {
    /* best effort */
  }
  return { ok: false, created: false }
}
