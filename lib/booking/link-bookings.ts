/**
 * Booking page — "Links I made": what REALLY happened to each link (booked, cancelled and by whom, or still waiting). Dev job a9285887, Antonio 15 Nov 2026:
 * both his test bookings were booked and then cancelled, and both rows still said "Waiting, not booked yet".
 *
 * Why the row did not know (and how it learns now)
 *   - While the Booking switch is "page" the webhook does not claim a link, so the row never learns its booking. But the booking IS stored: the webhook keeps every Calendly
 *     delivery in `webhook_events`, and the delivery carries the link's id (the tag `utm_term`). So the booking is found by that tag, with no change to the webhook.
 *   - Calendly never tells us about a CANCELLATION (the webhook only subscribes to "invitee.created"), so cancelled or not is read from Calendly itself, when the page opens.
 *   - If Calendly cannot be read (no key, a refusal, slow), the row says "Booked … could not check Calendly" — it never guesses "still booked" and never hides the booking.
 *
 * Pure rules here (`decideBooking`, `bookingText`); the two readers take their database / Calendly client as arguments and never throw.
 */

import { isStrictLinkId } from "@/lib/booking-links/id"
import { eventUuidOf, getScheduledEvent, type CalendlyCtx } from "@/lib/calendly/api"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic service client
type Db = any

/** One booking made through a link, as the webhook stored it. */
export interface StoredBooking {
  /** the link's public id (the tag) */
  tag: string
  /** Calendly's address of the booked event */
  eventUri: string
  /** when the call starts, as Calendly said at booking time (a later reschedule is a new booking) */
  startTime: string | null
  /** when we stored it */
  storedAt: string
  /** the booker's own cancel page (a Calendly address); only used as a fallback when the app may not cancel */
  cancelUrl: string | null
}

export type BookingState = "booked" | "booked_unchecked" | "cancelled_by_you" | "cancelled_by_booker" | "cancelled"

export interface LinkBooking {
  state: BookingState
  eventUri: string
  startTime: string | null
  /** how many bookings came in through this link (a reusable link can have several; this one describes the latest) */
  count: number
}

export interface EventFacts {
  status: string
  startTime: string | null
  cancelerType: string | null
}

const SELECT =
  "storedAt:created_at, tag:payload->payload->tracking->>utm_term, eventUri:payload->payload->>event, startTime:payload->payload->scheduled_event->>start_time, cancelUrl:payload->payload->>cancel_url"
const TAG_PATH = "payload->payload->tracking->>utm_term"
const MAX_ROWS = 500

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null)

/** The bookings the webhook stored for these links, newest first per link. Only ids of our exact shape are looked up. Never throws; { ok: false } = could not read. */
export async function loadStoredBookings(db: Db, publicIds: string[]): Promise<{ ok: true; byTag: Map<string, StoredBooking[]> } | { ok: false }> {
  const byTag = new Map<string, StoredBooking[]>()
  const ids = Array.from(new Set(publicIds.filter((id) => isStrictLinkId(id))))
  if (ids.length === 0) return { ok: true, byTag }
  try {
    const { data, error } = await db
      .from("webhook_events")
      .select(SELECT)
      .eq("source", "calendly")
      .eq("event_type", "invitee.created")
      .in(TAG_PATH, ids)
      .order("created_at", { ascending: false })
      .limit(MAX_ROWS)
    if (error) return { ok: false }
    for (const r of Array.isArray(data) ? data : []) {
      if (!isRec(r)) continue
      const tag = text(r.tag)
      const eventUri = text(r.eventUri)
      if (!tag || !eventUri || !eventUuidOf(eventUri)) continue
      const list = byTag.get(tag) ?? []
      list.push({ tag, eventUri, startTime: text(r.startTime), storedAt: text(r.storedAt) ?? "", cancelUrl: text(r.cancelUrl) })
      byTag.set(tag, list)
    }
    return { ok: true, byTag }
  } catch {
    return { ok: false }
  }
}

/** The booking addresses of one link, newest first, no repeats. A claimed link's own address counts as a booking even if no delivery of it is stored. */
export function bookingUrisOf(stored: StoredBooking[], claimedEventUri: string | null): string[] {
  const out: string[] = []
  for (const s of stored) if (!out.includes(s.eventUri)) out.push(s.eventUri)
  if (claimedEventUri && eventUuidOf(claimedEventUri) && !out.includes(claimedEventUri)) out.push(claimedEventUri)
  return out
}

const CHECK_MAX = 25
const CHECK_TIMEOUT_MS = 4_000

/** Reads these bookings from Calendly (at most 25, all at once, each given 4 seconds). A booking Calendly could not answer for is `null`. Never throws. */
export async function lookupEvents(ctx: CalendlyCtx, uris: string[]): Promise<Map<string, EventFacts | null>> {
  const out = new Map<string, EventFacts | null>()
  const wanted = Array.from(new Set(uris)).slice(0, CHECK_MAX)
  await Promise.all(
    wanted.map(async (uri) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const facts = await Promise.race([
          getScheduledEvent(ctx, uri),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("slow")), CHECK_TIMEOUT_MS)
          }),
        ])
        out.set(uri, { status: facts.status, startTime: facts.startTime, cancelerType: facts.cancelerType })
      } catch {
        out.set(uri, null)
      } finally {
        if (timer) clearTimeout(timer)
      }
    }),
  )
  return out
}

/**
 * What happened to a link's booking. `uris` are the link's bookings newest first; the latest is the one described.
 * `facts` = what Calendly said about it (`null` = could not be read, absent = never asked, which counts the same).
 */
export function decideBooking(input: { uris: string[]; stored: StoredBooking[]; facts: Map<string, EventFacts | null>; claimedStart?: string | null }): LinkBooking | null {
  const latest = input.uris[0]
  if (!latest) return null
  const count = input.uris.length
  const storedStart = input.stored.find((s) => s.eventUri === latest)?.startTime ?? input.claimedStart ?? null
  const facts = input.facts.get(latest) ?? null
  if (!facts) return { state: "booked_unchecked", eventUri: latest, startTime: storedStart, count }
  const startTime = facts.startTime ?? storedStart
  const s = facts.status.toLowerCase()
  if (s === "canceled" || s === "cancelled") {
    const by = (facts.cancelerType ?? "").toLowerCase()
    return { state: by === "invitee" ? "cancelled_by_booker" : by === "host" ? "cancelled_by_you" : "cancelled", eventUri: latest, startTime, count }
  }
  // "active" is a live booking; any other word Calendly might add is kept as a booking we could not fully read
  return { state: s === "active" ? "booked" : "booked_unchecked", eventUri: latest, startTime, count }
}

/** The words for the "What happened" column. `when` is the call's start already written in New York time ("Mon, Nov 16, 9:30 AM ET"), or null. */
export function bookingText(b: Pick<LinkBooking, "state" | "count">, when: string | null): string {
  const more = b.count > 1 ? ` · ${b.count} bookings in all` : ""
  switch (b.state) {
    case "booked": return `${when ? `Booked ${when}` : "Booked"}${more}`
    case "booked_unchecked": return `${when ? `Booked ${when}` : "Booked"} · could not check Calendly${more}`
    case "cancelled_by_you": return `Cancelled by you${when ? ` · was ${when}` : ""}${more}`
    case "cancelled_by_booker": return `Cancelled by the booker${when ? ` · was ${when}` : ""}${more}`
    case "cancelled": return `Cancelled${when ? ` · was ${when}` : ""}${more}`
  }
}

/** A booking that can still be cancelled from the page (a cancelled one cannot). */
export function canCancelBooking(state: BookingState): boolean {
  return state === "booked" || state === "booked_unchecked"
}

export function isCancelledState(state: BookingState): boolean {
  return !canCancelBooking(state)
}
