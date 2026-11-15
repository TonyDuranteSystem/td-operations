/**
 * Booking page — "Links I made": the list, what happened to each link, and stopping one. The database client is passed in; every function says plainly
 * when it could not read or write (a failed read is never shown as an empty list).
 */

import { linkUrl } from "@/lib/booking/make-link"
import { isMissingTable } from "@/lib/booking-links/missing-table"
import { parseRuleSnapshot } from "@/lib/booking/kinds"
import { bookingText, bookingUrisOf, canCancelBooking, decideBooking, loadStoredBookings, lookupEvents, type BookingState, type EventFacts } from "@/lib/booking/link-bookings"
import { loadLinkCards } from "@/lib/booking/link-cards"
import type { CardModel } from "@/lib/crm-lists/hover-cards"
import type { CalendlyCtx } from "@/lib/calendly/api"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- booking_links / contact_calls: untyped until the production migration is applied
type Db = any

export type LinkStatus = "open" | "claimed" | "revoked" | "expired"

export interface LinkRow {
  id: string
  public_id: string
  kind_label: string
  rule_snapshot: unknown
  contact_id: string | null
  lead_id: string | null
  person_name: string | null
  person_emails: string[] | null
  duration_minutes: number | null
  once: boolean
  status: string
  revoked_at: string | null
  expires_at: string | null
  claimed_event_uri: string | null
  claimed_at: string | null
  open_count: number | null
  last_opened_at: string | null
  created_at: string
  /** "sales" = the full questions, "plain" = the short note; null on a link made before this was kept */
  template_slug?: string | null
}

/** What happened to the booking made through a link (read from the stored booking and from Calendly). Null on a link nobody has booked with. */
export interface LinkBookingDto {
  state: BookingState
  startTime: string | null
  count: number
  /** the page may offer "Cancel the call" */
  canCancel: boolean
}

export interface LinkDto {
  id: string
  url: string
  /** who the link is for, as shown; null = someone new with no name */
  personName: string | null
  kindLabel: string
  kindSlug: string | null
  minutes: number | null
  once: boolean
  status: LinkStatus
  /** plain-English "what happened" */
  what: string
  opens: number
  madeAt: string
  /** when the booked call starts, if known */
  bookedStart: string | null
  /** to pre-fill "Make again" */
  contactId: string | null
  leadId: string | null
  email: string | null
  /** what the booker is asked: "full" = the sales questions, "short" = the one optional note; null = not known (an older link) */
  asks: "full" | "short" | null
  /** the booking made through this link, if any */
  booking: LinkBookingDto | null
  /** the little card shown on pointing at the name; null = nothing to show (someone new with no name or email) */
  card: CardModel | null
}

/** open | claimed | revoked | expired. Revoked wins; a claimed link stays claimed whatever its expiry says (expiry only stops a link nobody has claimed). */
export function linkStatusOf(row: Pick<LinkRow, "status" | "revoked_at" | "expires_at">, now: Date): LinkStatus {
  if (row.revoked_at) return "revoked"
  if (row.status === "claimed") return "claimed"
  if (row.expires_at && new Date(row.expires_at).getTime() < now.getTime()) return "expired"
  return "open"
}

const DAY_FMT: Intl.DateTimeFormatOptions = { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
export function nyWhen(iso: string): string {
  return `${new Date(iso).toLocaleString("en-US", DAY_FMT)} ET`
}

export function describeLinkState(status: LinkStatus, row: Pick<LinkRow, "once" | "open_count">, bookedStart: string | null): string {
  const opened = (row.open_count ?? 0) > 0 ? ` · opened ${row.open_count} time${row.open_count === 1 ? "" : "s"}` : ""
  switch (status) {
    case "revoked": return "Stopped by you"
    case "expired": return "Not used, expired"
    case "claimed": return bookedStart ? `Booked ${nyWhen(bookedStart)}` : "Booked"
    default: return row.once ? `Waiting, not booked yet${opened}` : `Open for bookings${opened}`
  }
}

const COLUMNS =
  "id, public_id, kind_label, rule_snapshot, contact_id, lead_id, person_name, person_emails, duration_minutes, once, status, revoked_at, expires_at, claimed_event_uri, claimed_at, open_count, last_opened_at, created_at, template_slug"

/**
 * The list. With a Calendly client, each link's latest booking is read from Calendly too (booked, or cancelled and by whom); without one every booking
 * is shown as "could not check Calendly". Reading the stored bookings, the cards or Calendly can fail without ever hiding a link.
 */
export async function listLinks(db: Db, now: Date, limit = 100, baseUrl?: string, calendly?: CalendlyCtx): Promise<{ ok: true; links: LinkDto[] } | { ok: false; error: string }> {
  try {
    const { data, error } = await db.from("booking_links").select(COLUMNS).order("created_at", { ascending: false }).limit(limit)
    if (error) return isMissingTable(error) ? { ok: true, links: [] } : { ok: false, error: "The links could not be read. Try again." }
    const rows = (data ?? []) as LinkRow[]

    // the bookings made through these links (the webhook stores every one with the link's id), then what Calendly says about the latest of each
    const stored = await loadStoredBookings(db, rows.map((r) => r.public_id))
    const storedOf = (r: LinkRow) => (stored.ok ? stored.byTag.get(r.public_id) ?? [] : [])
    const urisOf = new Map(rows.map((r) => [r.id, bookingUrisOf(storedOf(r), r.claimed_event_uri)] as const))
    const latest = rows.map((r) => urisOf.get(r.id)?.[0]).filter((u): u is string => !!u)
    const facts: Map<string, EventFacts | null> = calendly && latest.length ? await lookupEvents(calendly, latest) : new Map()
    const cards = await loadLinkCards(db, rows)

    // when each booked call starts (read from the call log the engine wrote); a failed read only leaves the time out
    const uris = rows.map((r) => r.claimed_event_uri).filter((u): u is string => !!u)
    const start = new Map<string, string>()
    if (uris.length) {
      const [cc, lc] = await Promise.all([
        db.from("contact_calls").select("calendly_event_uri, scheduled_start").in("calendly_event_uri", uris),
        db.from("lead_calls").select("calendly_event_uri, scheduled_start").in("calendly_event_uri", uris),
      ])
      for (const res of [cc, lc]) {
        if (res.error) continue
        for (const c of (res.data ?? []) as Array<{ calendly_event_uri: string | null; scheduled_start: string | null }>) if (c.calendly_event_uri && c.scheduled_start) start.set(c.calendly_event_uri, c.scheduled_start)
      }
    }

    return {
      ok: true,
      links: rows.map((r) => {
        const status = linkStatusOf(r, now)
        const booked = r.claimed_event_uri ? start.get(r.claimed_event_uri) ?? null : null
        const found = decideBooking({ uris: urisOf.get(r.id) ?? [], stored: storedOf(r), facts, claimedStart: booked })
        const booking: LinkBookingDto | null = found ? { state: found.state, startTime: found.startTime, count: found.count, canCancel: canCancelBooking(found.state) } : null
        return {
          id: r.id,
          url: linkUrl(r.public_id, baseUrl),
          personName: r.person_name,
          kindLabel: r.kind_label,
          kindSlug: parseRuleSnapshot(r.rule_snapshot)?.kind_slug ?? null,
          minutes: r.duration_minutes,
          once: r.once,
          status,
          what: found ? bookingText(found, found.startTime ? nyWhen(found.startTime) : null) : describeLinkState(status, r, booked),
          opens: r.open_count ?? 0,
          madeAt: r.created_at,
          bookedStart: found?.startTime ?? booked,
          contactId: r.contact_id,
          leadId: r.lead_id,
          email: Array.isArray(r.person_emails) && r.person_emails.length ? r.person_emails[0] : null,
          asks: r.template_slug === "sales" ? "full" : r.template_slug === "plain" ? "short" : null,
          booking,
          card: cards.get(r.id) ?? null,
        }
      }),
    }
  } catch {
    return { ok: false, error: "The links could not be read. Try again." }
  }
}

export type RevokeResult = { ok: true; message: string } | { ok: false; status: number; error: string }

/** Stops a link nobody has booked with yet. One conditional update; "already stopped" is success. */
export async function revokeLink(db: Db, id: string, now: Date): Promise<RevokeResult> {
  try {
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return { ok: false, status: 404, error: "That link could not be found." }
    const { data, error } = await db
      .from("booking_links")
      .update({ revoked_at: now.toISOString(), updated_at: now.toISOString() })
      .eq("id", id)
      .eq("status", "open")
      .is("revoked_at", null)
      .select("id")
    if (error) return { ok: false, status: 500, error: "The link could not be stopped. Try again." }
    if (Array.isArray(data) && data.length > 0) return { ok: true, message: "The link is stopped. Anyone opening it now lands on the normal booking page." }
    const { data: row, error: readErr } = await db.from("booking_links").select("status, revoked_at").eq("id", id).maybeSingle()
    if (readErr) return { ok: false, status: 500, error: "The link could not be stopped. Try again." }
    if (!row) return { ok: false, status: 404, error: "That link could not be found." }
    if (row.revoked_at) return { ok: true, message: "The link was already stopped." }
    return { ok: false, status: 409, error: "Someone has already booked with this link, so it cannot be stopped." }
  } catch {
    return { ok: false, status: 500, error: "The link could not be stopped. Try again." }
  }
}
