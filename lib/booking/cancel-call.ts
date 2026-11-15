/**
 * Booking page — "Cancel the call" on a row of "Links I made" (dev job a9285887, Antonio 15 Nov 2026).
 *
 * Cancels the booking made through one link, in Calendly (Calendly then emails the booker — the page says so before asking for the second click).
 * The booking is found the same way the list finds it (the stored delivery carrying the link's id, or the claimed booking), so it works while the Booking switch is "page".
 *
 *   - "Already cancelled" is a success (a double click, or it was cancelled in Calendly a moment ago).
 *   - If Calendly will not let the app cancel (no key, or the key may not cancel — UNPROVEN until a first real use), nothing is cancelled and the answer carries the booker's own
 *     cancel page, so staff can still do it by hand; that page is a Calendly address stored with the booking, shown only on this refusal.
 *   - A link nobody booked with has nothing to cancel.
 * The reason Calendly shows the booker is fixed text, never typed by anyone. Never throws.
 */

import { CalendlyError, type CalendlyCtx } from "@/lib/calendly/api"
import { cancelEvent } from "@/lib/calendly/api-write"
import { isPlainCalendlyUrl } from "@/lib/booking-links/destination"
import { bookingUrisOf, loadStoredBookings } from "@/lib/booking/link-bookings"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- booking_links: untyped until the production migration is applied
type Db = any

export const CANCEL_REASON = "Cancelled by the host."

export type CancelCallResult =
  | { ok: true; message: string }
  | { ok: false; status: number; error: string; /** the booker's own cancel page, offered only when the app itself may not cancel */ cancelUrl?: string }

/** Plain words for a Calendly refusal (R099): what happened and what to do, never the technical text. */
export function cancelFailureText(err: unknown): string {
  if (!(err instanceof CalendlyError)) return "The call could not be cancelled. Nothing was cancelled. Try again."
  switch (err.kind) {
    case "not_configured": return "Calendly is not connected to this system, so it cannot cancel the call from here. Nothing was cancelled."
    case "auth":
    case "forbidden": return "Calendly did not allow the app to cancel this call. Nothing was cancelled."
    case "rate_limited": return "Calendly is busy. Wait a minute and try again. Nothing was cancelled."
    case "network":
    case "server": return "Calendly could not be reached. Nothing was cancelled. Try again in a moment."
    default: return "Calendly would not cancel this call. Nothing was cancelled."
  }
}

/** The refusals after which a hand-made cancel is the sensible next step (the app may not cancel, or has no key). */
function offersHandCancel(err: unknown): boolean {
  return err instanceof CalendlyError && (err.kind === "not_configured" || err.kind === "auth" || err.kind === "forbidden")
}

export async function cancelLinkCall(deps: { db: Db; calendly: CalendlyCtx }, id: string): Promise<CancelCallResult> {
  const { db } = deps
  try {
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return { ok: false, status: 404, error: "That link could not be found." }
    const { data: row, error } = await db.from("booking_links").select("public_id, claimed_event_uri").eq("id", id).maybeSingle()
    if (error) return { ok: false, status: 500, error: "The call could not be cancelled. Nothing was cancelled. Try again." }
    if (!row) return { ok: false, status: 404, error: "That link could not be found." }

    const stored = await loadStoredBookings(db, [row.public_id as string])
    if (!stored.ok) return { ok: false, status: 500, error: "The booking could not be looked up. Nothing was cancelled. Try again." }
    const bookings = stored.byTag.get(row.public_id as string) ?? []
    const uri = bookingUrisOf(bookings, (row.claimed_event_uri as string | null) ?? null)[0]
    if (!uri) return { ok: false, status: 409, error: "Nobody has booked with this link, so there is no call to cancel." }

    try {
      const r = await cancelEvent(deps.calendly, uri, CANCEL_REASON)
      return { ok: true, message: r.alreadyCancelled ? "That call was already cancelled." : "The call is cancelled. Calendly is telling the booker." }
    } catch (err) {
      const hand = bookings.find((b) => b.eventUri === uri)?.cancelUrl ?? null
      const cancelUrl = offersHandCancel(err) && hand && isPlainCalendlyUrl(hand) ? hand : undefined
      return { ok: false, status: 502, error: cancelFailureText(err), ...(cancelUrl ? { cancelUrl } : {}) }
    }
  } catch {
    return { ok: false, status: 500, error: "The call could not be cancelled. Nothing was cancelled. Try again." }
  }
}
