/**
 * Calendly API — the WRITE side (Stage 1b of the Booking page, dev job 19d2654a): make a one-time link with its own length, and cancel a booking.
 *
 * ONLY the Booking page's own code may import this file (lib/booking, app/api/booking). The MCP tools and the Slack worker must never reach it — a test pins that
 * with a list of allowed importers, so a future tool cannot quietly gain the power to cancel a client's call.
 *
 * Both calls use the app's own token (CALENDLY_PAT). What that token is allowed to do is Calendly's side and is UNPROVEN until a controlled live test with a test
 * person (the share call needs `shares:write`, the cancel call `scheduled_events:write` in Calendly's own API reference). Until then nothing in the app calls these
 * on its own: a link with its own length is made only when Antonio clicks "make link", and cancelling is not wired to any screen yet.
 */

import { CalendlyError, calendlyRequest, eventTypeUri, eventTypeUuidOf, eventUuidOf, getScheduledEvent, CALENDLY_API, type CalendlyCtx } from "@/lib/calendly/api"
import { isPlainCalendlyUrl } from "@/lib/booking-links/destination"

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

export interface ShareLinkInput {
  /** the Calendly event type the link is made from (an address taken from app_settings.booking_templates) */
  eventTypeUri: string
  /** the length in whole minutes, 1-720 */
  minutes: number
}

/**
 * Makes a one-time scheduling link with its own length ("Customize once and share"). Calendly closes it after one booking, even if that booking is later cancelled.
 * Only the event type, the length and the one allowed length option are sent: every other setting is copied from the event type by Calendly.
 * Returns the https://calendly.com/... address; anything else in the answer is refused.
 */
export async function createShareLink(ctx: CalendlyCtx, input: ShareLinkInput): Promise<{ url: string }> {
  const uuid = eventTypeUuidOf(input.eventTypeUri)
  if (!uuid) throw new CalendlyError("bad_request", null, "The Calendly event type address was not valid.")
  if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 720) throw new CalendlyError("bad_request", null, "The length must be a whole number of minutes from 1 to 720.")
  const json = await calendlyRequest(ctx, "POST", "/shares", { event_type: eventTypeUri(uuid), duration: input.minutes, duration_options: [input.minutes] })
  const resource = isRec(json) && isRec(json.resource) ? json.resource : null
  const links = resource && Array.isArray(resource.scheduling_links) ? resource.scheduling_links : []
  const first = links.find((l) => isRec(l) && typeof l.booking_url === "string") as Record<string, unknown> | undefined
  const url = first ? (first.booking_url as string) : null
  if (!url || !isPlainCalendlyUrl(url)) throw new CalendlyError("bad_response", 201, "Calendly made the link but the answer did not hold a usable address.")
  return { url }
}

export interface CancelResult {
  /** true = the booking was already cancelled (counts as success) */
  alreadyCancelled: boolean
}

/**
 * Cancels one booking in Calendly (Calendly then tells the person). The reason is fixed text chosen by the caller, never typed by a visitor.
 * "Already cancelled" is a success: if Calendly refuses the request, the booking is read back and a cancelled one ends as success.
 */
export async function cancelEvent(ctx: CalendlyCtx, eventUri: string, reason: string): Promise<CancelResult> {
  const uuid = eventUuidOf(eventUri)
  if (!uuid) throw new CalendlyError("bad_request", null, "That booking's Calendly address was not valid.")
  const cleanReason = reason.replace(/\s+/g, " ").trim().slice(0, 500)
  try {
    await calendlyRequest(ctx, "POST", `/scheduled_events/${uuid}/cancellation`, cleanReason ? { reason: cleanReason } : {})
    return { alreadyCancelled: false }
  } catch (err) {
    // Only a refusal of the request itself can mean "it is already cancelled". A broken key, a missing key, a busy or unreachable Calendly are real failures.
    if (!(err instanceof CalendlyError) || (err.kind !== "bad_request" && err.kind !== "not_found")) throw err
    try {
      const event = await getScheduledEvent(ctx, `${CALENDLY_API}/scheduled_events/${uuid}`)
      if (event.status === "canceled" || event.status === "cancelled") return { alreadyCancelled: true }
    } catch {
      /* fall through to the original error */
    }
    throw err
  }
}
