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

/** One answer the booker gave on Calendly's booking page. */
export interface BookerAnswer {
  question: string
  answer: string
}

/**
 * Who made the booking, as Calendly sent it and the webhook stored it (dev job 4ebfe4d3, Antonio 15 Nov 2026: "more information about who booked it").
 * What Calendly sends depends on the call type (read from the 104 stored deliveries on 15 Nov 2026): "Free meet&greet call" (93) and "Free Call" (3) send the full name AND a separate first
 * and last name; "New Meeting", "Strategic Call" and "TD Strategic Consulting" send ONE full name only. So the full name is always shown as sent, and the first and last name are kept
 * (and shown on the card) only when Calendly really sent them — nothing here ever guesses where a name splits.
 */
export interface Booker {
  name: string | null
  /** only when Calendly sent a separate first name (some call types do, some do not) */
  firstName?: string | null
  /** only when Calendly sent a separate last name */
  lastName?: string | null
  email: string | null
  phone: string | null
  answers: BookerAnswer[]
}

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
  /** who booked; null when the stored delivery carries nothing about them */
  booker: Booker | null
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
  "storedAt:created_at, tag:payload->payload->tracking->>utm_term, eventUri:payload->payload->>event, startTime:payload->payload->scheduled_event->>start_time, cancelUrl:payload->payload->>cancel_url, " +
  "bookerName:payload->payload->>name, bookerFirst:payload->payload->>first_name, bookerLast:payload->payload->>last_name, bookerEmail:payload->payload->>email, bookerPhone:payload->payload->>text_reminder_number, bookerAnswers:payload->payload->questions_and_answers"
const TAG_PATH = "payload->payload->tracking->>utm_term"
const MAX_ROWS = 500

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

const MAX_ANSWERS = 6
const MAX_ANSWER_CHARS = 300

/** The booker, from the fields of one stored delivery. The name is the full name Calendly sent, else first + last joined; the separate first and last name are kept when sent. Null when the delivery says nothing about them. */
export function parseBooker(r: { name?: unknown; first?: unknown; last?: unknown; email?: unknown; phone?: unknown; answers?: unknown }): Booker | null {
  const first = text(r.first)
  const last = text(r.last)
  const name = text(r.name) ?? ([first, last].filter(Boolean).join(" ") || null)
  const email = text(r.email)
  const phone = text(r.phone)
  const answers: BookerAnswer[] = []
  if (Array.isArray(r.answers)) {
    for (const a of r.answers) {
      if (!isRec(a)) continue
      const question = text(a.question)
      const answer = text(a.answer)
      if (question && answer) answers.push({ question: question.split("\n")[0].slice(0, 200), answer: answer.slice(0, MAX_ANSWER_CHARS) })
      if (answers.length >= MAX_ANSWERS) break
    }
  }
  return name || email || phone || answers.length ? { name, firstName: first, lastName: last, email, phone, answers } : null
}

export interface WhoBooked {
  /** the bold line: who the link is for, or the booker when the link has no name */
  primary: string
  /** the small line under it: the booker's email, or "Booked by <name> · <email>" when the booker is not who the link was made for */
  secondary: string | null
  /** the booker is not the person the link was made for (a different email, or a different name) */
  differs: boolean
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim()

/** What the "For" column shows. PURE. A link with a name keeps it; a link with no name shows the booker. Both are shown when they differ, so a wrong-email booking is easy to see. */
export function whoBooked(link: { personName: string | null; personEmails: string[] | null }, booker: Booker | null): WhoBooked {
  const linkName = text(link.personName)
  if (!booker) return { primary: linkName ?? "Someone new", secondary: null, differs: false }
  const bName = booker.name
  const bEmail = booker.email
  if (!linkName) {
    return bName ? { primary: bName, secondary: bEmail, differs: false } : { primary: bEmail ?? "Someone new", secondary: null, differs: false }
  }
  const emails = (link.personEmails ?? []).map((e) => norm(e))
  const emailDiffers = emails.length > 0 && !!bEmail && !emails.includes(norm(bEmail))
  const nameDiffers = !!bName && norm(bName) !== norm(linkName)
  const differs = emailDiffers || nameDiffers
  const who = [bName, bEmail].filter(Boolean).join(" · ")
  return { primary: linkName, secondary: differs ? (who ? `Booked by ${who}` : null) : bEmail, differs }
}

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
      list.push({
        tag,
        eventUri,
        startTime: text(r.startTime),
        storedAt: text(r.storedAt) ?? "",
        cancelUrl: text(r.cancelUrl),
        booker: parseBooker({ name: r.bookerName, first: r.bookerFirst, last: r.bookerLast, email: r.bookerEmail, phone: r.bookerPhone, answers: r.bookerAnswers }),
      })
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
export async function lookupEvents(ctx: CalendlyCtx, uris: string[], max: number = CHECK_MAX): Promise<Map<string, EventFacts | null>> {
  const out = new Map<string, EventFacts | null>()
  const wanted = Array.from(new Set(uris)).slice(0, max)
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
