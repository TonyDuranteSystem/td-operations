/**
 * Booking page, PAID links — "book and pay" on OUR page (dev job 74432428, Antonio 16 Nov 2026: "everything in our system … he will open the page, book the call, and pay").
 *
 * The person opens the link, which leads to our own page /pay/b/<code>. The page lists the FREE times of the paid call type (read from Calendly), the person picks one and
 * types their name and email; the call is BOOKED right then through Calendly's Scheduling API (the booking is tagged with the link's id exactly like a booking made on Calendly's
 * own page, so the stored delivery, the cards, the webhook and "Cancel the call" all keep working), and the same page sends them on to the card page (pay-session.ts).
 * Calendly shows the person nothing; it only holds the calendar, makes the Zoom link and sends its own confirmation email.
 *
 * The rules (each has a test):
 *   - only a link that is open can book: not paid, not "Not charging", not stopped, not expired, and not already booked (a paid link is one call)
 *   - the paid call is always the PLAIN call type (name + email only: the sales questions cannot be asked on this page) and exactly the length the link was made with; a call type whose
 *     length no longer matches, or whose place needs more than Calendly's own link (an address, a phone number), is refused with a plain sentence and a system error
 *   - the booking is guarded by the short lease on the row (session_claim_at, the same 30-second lease the card page uses; the two never run at the same moment), so two taps at the same
 *     second make ONE booking; the link is marked booked in one statement conditioned on that lease, and a booking Calendly made that the link cannot record is cancelled again
 *   - a time somebody else took is "taken": the page asks for another; Calendly's own refusal text is never shown
 * Every function takes its database / Calendly client as an argument and never throws.
 */

import { CalendlyError, getEventType, listAvailableTimes, type CalendlyCtx } from "@/lib/calendly/api"
import { bookInvitee, cancelEvent } from "@/lib/calendly/api-write"
import { findPayLink, LEASE_MS, type PayRow } from "@/lib/booking/pay-session"
import { isPlainEmail, payStateOf } from "@/lib/booking/payment"
import { linkStatusOf } from "@/lib/booking/links"
import { loadTemplates, templateFor, type BookingTemplate } from "@/lib/booking/templates"
import { isUniqueViolation } from "@/lib/booking-links/missing-table"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- booking_links: untyped until the production migration is applied
type Db = any

/** how far ahead the page offers times (Calendly allows at most 31 days in one request) */
export const SLOT_DAYS = 21
/** the earliest start asked of Calendly (its own minimum notice still applies) */
const SOON_MS = 2 * 60_000

export type BookNo = "none" | "closed" | "paid" | "booked" | "busy" | "taken" | "invalid" | "calendly" | "setup" | "error"

export const BOOK_SAYS: Record<BookNo, string> = {
  none: "This link is not valid. Please ask the person who sent it for a new one.",
  closed: "This link is no longer open. Please ask the person who sent it for a new one.",
  paid: "This payment was already received. Thank you.",
  booked: "A time is already booked with this link.",
  busy: "We are booking your call. Please wait a few seconds and try again.",
  taken: "That time was just taken. Please pick another one.",
  invalid: "Please check your details and try again.",
  calendly: "The calendar could not be reached. Please try again in a moment.",
  setup: "Booking is not available right now. Please contact us and we will book it for you.",
  error: "We could not book your call right now. Please try again in a minute.",
}

export const BOOK_STATUS: Record<BookNo, number> = { none: 404, closed: 410, paid: 200, booked: 409, busy: 503, taken: 409, invalid: 400, calendly: 502, setup: 503, error: 503 }

export interface BookDeps {
  db: Db
  calendly?: CalendlyCtx
  now?: Date
  reportError?: (message: string, context: Record<string, unknown>) => Promise<void>
}

const no = <T extends { ok: false; reason: BookNo; message: string }>(reason: BookNo, message?: string): T => ({ ok: false, reason, message: message ?? BOOK_SAYS[reason] }) as T

async function defaultReport(message: string, context: Record<string, unknown>): Promise<void> {
  const { reportSystemError } = await import("@/lib/system-errors")
  await reportSystemError({ source: "server", route: "/pay/b/[code]/book", message, context })
}

async function report(deps: BookDeps, message: string, context: Record<string, unknown>): Promise<void> {
  try {
    await (deps.reportError ?? defaultReport)(message, context)
  } catch {
    /* a failed report never changes the answer */
  }
}

/** The kinds of place Calendly can fill in by itself (nothing more is needed from us). */
const SIMPLE_LOCATIONS: ReadonlySet<string> = new Set(["zoom_conference", "google_conference", "gotomeeting_conference", "microsoft_teams_conference", "webex_conference", "inbound_call"])

/** The place to send with the booking: none (Calendly decides), one Calendly can fill in, or null = this call type needs details we cannot give. */
export function locationFor(kinds: string[]): { kind: string | null } | null {
  if (kinds.length === 0) return { kind: null }
  return SIMPLE_LOCATIONS.has(kinds[0]) ? { kind: kinds[0] } : null
}

export type Bookable = { ok: true; row: PayRow; template: BookingTemplate } | { ok: false; reason: BookNo; message: string }

/** Is this link open for a booking, and which call type does it use? Reads only. */
export async function readBookable(deps: BookDeps, code: unknown): Promise<Bookable> {
  const now = deps.now ?? new Date()
  const found = await findPayLink(deps.db, code)
  if (found.state === "none") return no("none")
  if (found.state === "error") return no("error")
  const row = found.row
  if (payStateOf(row) === "paid") return no("paid")
  if (payStateOf(row) === "not_charging" || row.revoked_at) return no("closed")
  if (row.status === "claimed" || row.claimed_event_uri) return no("booked")
  if (linkStatusOf({ status: row.status ?? "open", revoked_at: row.revoked_at, expires_at: row.expires_at ?? null }, now) !== "open") return no("closed")
  const template = templateFor(await loadTemplates(deps.db), "plain")
  if (!template) {
    await report(deps, "A paid link could not be booked: the plain Calendly call type is not set up (app_settings.booking_templates).", { link: row.public_id })
    return no("setup")
  }
  return { ok: true, row, template }
}

/** What a Calendly failure means to the person: a time that is gone, a calendar that is busy, or something only we can fix. */
function failureReason(err: unknown): BookNo {
  if (!(err instanceof CalendlyError)) return "error"
  switch (err.kind) {
    case "bad_request": return "taken"
    case "not_configured":
    case "auth":
    case "forbidden": return "setup"
    case "rate_limited":
    case "network":
    case "server": return "calendly"
    default: return "error"
  }
}

export type SlotsResult = { ok: true; slots: string[]; minutes: number } | { ok: false; reason: BookNo; message: string }

/** The free times the person can pick from (ISO, UTC, earliest first). */
export async function loadSlots(deps: BookDeps, code: unknown): Promise<SlotsResult> {
  const now = deps.now ?? new Date()
  const b = await readBookable(deps, code)
  if ("reason" in b) return b
  if (!deps.calendly) return no("setup")
  try {
    const start = new Date(now.getTime() + SOON_MS)
    const end = new Date(now.getTime() + SLOT_DAYS * 86_400_000)
    const slots = await listAvailableTimes(deps.calendly, b.template.eventTypeUri, { start, end })
    return { ok: true, slots, minutes: typeof b.row.duration_minutes === "number" && b.row.duration_minutes > 0 ? b.row.duration_minutes : 30 }
  } catch (err) {
    const reason = failureReason(err)
    if (reason === "setup" || reason === "error") await report(deps, `The free times of a paid link could not be read from Calendly (${err instanceof CalendlyError ? err.kind : "unknown"}).`, { link: b.row.public_id })
    return no(reason === "taken" ? "error" : reason)
  }
}

export interface BookInputRaw {
  start: unknown
  name: unknown
  email: unknown
  timezone: unknown
}

export interface BookedCall {
  /** the start of the booked call (ISO, UTC) */
  start: string
}

export type BookResult = ({ ok: true } & BookedCall) | { ok: false; reason: BookNo; message: string }

const cleanName = (v: unknown): string | null => {
  if (typeof v !== "string") return null
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
  return s.length >= 1 && s.length <= 100 ? s : null
}

/** An IANA time zone name, or New York when the text is anything else (the call is in New York business hours; the zone only shapes Calendly's own emails). */
export function cleanTimezone(v: unknown): string {
  if (typeof v === "string" && v.length <= 64 && /^[A-Za-z0-9_+\-/]+$/.test(v)) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: v })
      return v
    } catch {
      /* fall through */
    }
  }
  return "America/New_York"
}

/** The person's pick: one of the times Calendly offers, as a UTC ISO text, in the future and inside the offered window. */
export function cleanStart(v: unknown, now: Date): string | null {
  if (typeof v !== "string" || v.length > 40) return null
  const t = Date.parse(v)
  if (!Number.isFinite(t)) return null
  if (t < now.getTime() + SOON_MS || t > now.getTime() + (SLOT_DAYS + 1) * 86_400_000) return null
  return new Date(t).toISOString()
}

async function releaseLease(db: Db, id: string, lease: string): Promise<void> {
  try {
    await db.from("booking_links").update({ session_claim_at: null }).eq("id", id).eq("session_claim_at", lease)
  } catch {
    /* the lease runs out by itself after 30 seconds */
  }
}

/** The one function behind "Book and pay": checks, takes the lease, books the call, marks the link booked. */
export async function bookSlot(deps: BookDeps, code: unknown, raw: BookInputRaw): Promise<BookResult> {
  const { db } = deps
  const now = deps.now ?? new Date()
  const start = cleanStart(raw.start, now)
  const name = cleanName(raw.name)
  const email = typeof raw.email === "string" ? raw.email.trim() : ""
  if (!start) return no("invalid", "Please pick one of the times shown.")
  if (!name) return no("invalid", "Please write your name.")
  if (!isPlainEmail(email) || email.length > 200) return no("invalid", "Please write a valid email address.")
  if (!deps.calendly) return no("setup")

  const b = await readBookable(deps, code)
  if ("reason" in b) return b
  const { row, template } = b

  // the call type must still be what the link promised (its length) and a place Calendly can fill in by itself
  let locationKind: string | null
  try {
    const facts = await getEventType(deps.calendly, template.eventTypeUri)
    const place = locationFor(facts.locationKinds)
    const minutes = typeof row.duration_minutes === "number" && row.duration_minutes > 0 ? row.duration_minutes : 30
    if (!facts.active || !place || facts.durationMinutes !== minutes) {
      await report(deps, "A paid link could not be booked: the plain Calendly call type no longer matches (inactive, another length, or a place that needs more details).", { link: row.public_id, minutes, calendlyMinutes: facts.durationMinutes, locations: facts.locationKinds })
      return no("setup")
    }
    locationKind = place.kind
  } catch (err) {
    const reason = failureReason(err)
    if (reason === "setup" || reason === "error") await report(deps, `A paid link could not be booked: the call type could not be read from Calendly (${err instanceof CalendlyError ? err.kind : "unknown"}).`, { link: row.public_id })
    return no(reason === "taken" ? "error" : reason)
  }

  // the lease: only one booking at a time, and only while the link is still open
  const lease = now.toISOString()
  const cutoff = new Date(now.getTime() - LEASE_MS).toISOString()
  try {
    const { data, error } = await db
      .from("booking_links")
      .update({ session_claim_at: lease })
      .eq("id", row.id)
      .eq("status", "open")
      .is("claimed_event_uri", null)
      .is("revoked_at", null)
      .is("paid_session_id", null)
      .is("not_charging_at", null)
      .or(`session_claim_at.is.null,session_claim_at.lt.${cutoff}`)
      .select("id")
    if (error) return no("error")
    if (!Array.isArray(data) || data.length === 0) return no("busy")
  } catch {
    return no("error")
  }

  let booked: Awaited<ReturnType<typeof bookInvitee>>
  try {
    booked = await bookInvitee(deps.calendly, { eventTypeUri: template.eventTypeUri, startTime: start, name, email, timezone: cleanTimezone(raw.timezone), tag: row.public_id, locationKind })
  } catch (err) {
    await releaseLease(db, row.id, lease)
    const reason = failureReason(err)
    if (reason === "setup" || reason === "error") await report(deps, `A paid call could not be booked in Calendly (${err instanceof CalendlyError ? `${err.kind} ${err.status ?? ""}`.trim() : "unknown"}).`, { link: row.public_id })
    return no(reason)
  }

  // mark the link booked in ONE statement, conditioned on our lease and on the link still being open
  let saved = false
  try {
    const { data, error } = await db
      .from("booking_links")
      .update({ status: "claimed", claimed_invitee_uri: booked.inviteeUri, claimed_event_uri: booked.eventUri, claimed_email: email.toLowerCase(), claimed_at: now.toISOString(), session_claim_at: null, updated_at: now.toISOString() })
      .eq("id", row.id)
      .eq("status", "open")
      .eq("session_claim_at", lease)
      .is("revoked_at", null)
      .is("not_charging_at", null)
      .select("id")
    saved = !error && Array.isArray(data) && data.length > 0
    if (error && isUniqueViolation(error)) saved = false
  } catch {
    saved = false
  }
  if (!saved) {
    // Calendly holds a call the link does not know about: cancel it (the person is told by Calendly) and say so
    await cancelEvent(deps.calendly, booked.eventUri, "This time could not be confirmed.").catch(() => undefined)
    await releaseLease(db, row.id, lease)
    await report(deps, "A paid call was booked in Calendly but the link could not be marked booked (it was stopped meanwhile, or the save failed). The call was cancelled again.", { link: row.public_id, event: booked.eventUri })
    return no("error")
  }
  return { ok: true, start }
}
