/**
 * Booking page — "Links I made": the list, what happened to each link, and stopping one. The database client is passed in; every function says plainly
 * when it could not read or write (a failed read is never shown as an empty list).
 */

import { linkUrl } from "@/lib/booking/make-link"
import { isMissingTable } from "@/lib/booking-links/missing-table"
import { parseRuleSnapshot } from "@/lib/booking/kinds"
import { bookingText, bookingUrisOf, canCancelBooking, decideBooking, loadStoredBookings, lookupEvents, whoBooked, type Booker, type BookingState, type EventFacts, type WhoBooked } from "@/lib/booking/link-bookings"
import { loadLinkCards } from "@/lib/booking/link-cards"
import { isPaidLink, moneyText, payStateOf, payUrl, type PayState } from "@/lib/booking/payment"
import { stopChargingIfPaidLink } from "@/lib/booking/pay-actions"
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
  /** the payment columns of a PAID link (Stage 3); all null / absent on a free link and on a database that does not have them yet */
  pay_amount_cents?: number | null
  pay_currency?: string | null
  pay_label?: string | null
  pay_mode?: string | null
  pay_code?: string | null
  sent_at?: string | null
  sent_count?: number | null
  paid_session_id?: string | null
  paid_at?: string | null
  not_charging_at?: string | null
}

/** The money side of a paid link's row on the page. Null on a free link. */
export interface LinkPayDto {
  state: PayState
  amountText: string
  /** plain words for the "What happened" column: "$397.00 · not paid yet", "$397.00 · paid", ... */
  text: string
  /** our own payment page's address (Copy payment link) */
  payUrl: string
  /** to pre-fill "Make again" with the same price (a made-again link must never silently turn free) */
  amount: string
  currency: "USD" | "EUR"
  label: string | null
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
  /** what the "For" column shows: who the link is for and, once someone has booked, who actually booked */
  who: WhoBooked
  /** the little card shown on pointing at the name; null = nothing to show (someone new with no name or email) */
  card: CardModel | null
  /** the price and whether it was paid; null on a free link */
  pay: LinkPayDto | null
}

/** What the row says about the money. PURE. Null for a free link. */
export function payDtoOf(row: Pick<LinkRow, "pay_amount_cents" | "pay_currency" | "pay_code" | "pay_label" | "paid_session_id" | "not_charging_at" | "sent_at">, baseUrl?: string): LinkPayDto | null {
  if (!isPaidLink({ pay_amount_cents: row.pay_amount_cents ?? null, pay_currency: row.pay_currency ?? null, pay_code: row.pay_code ?? null })) return null
  const state = payStateOf({ paid_session_id: row.paid_session_id ?? null, not_charging_at: row.not_charging_at ?? null })
  const amountText = moneyText(row.pay_amount_cents as number, row.pay_currency as string)
  const words = state === "paid" ? "paid" : state === "not_charging" ? "not charging" : row.sent_at ? "not paid yet · link sent" : "not paid yet"
  const cents = row.pay_amount_cents as number
  return {
    state,
    amountText,
    text: `${amountText} · ${words}`,
    payUrl: payUrl(row.pay_code as string, baseUrl),
    amount: (cents / 100).toFixed(2),
    currency: row.pay_currency === "EUR" ? "EUR" : "USD",
    label: row.pay_label?.trim() || null,
  }
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
/** The payment columns arrive with the Stage 3 migration. A database that does not have them yet (the code is deployed first) is read without them: every link is then a free link. */
const PAY_COLUMNS = ", pay_amount_cents, pay_currency, pay_label, pay_mode, pay_code, sent_at, sent_count, paid_session_id, paid_at, not_charging_at"
const UNDEFINED_COLUMN = "42703"

async function selectLinks(db: Db, limit: number): Promise<{ data: unknown; error: { code?: unknown } | null }> {
  const first = await db.from("booking_links").select(COLUMNS + PAY_COLUMNS).order("created_at", { ascending: false }).limit(limit)
  if (first.error && (first.error as { code?: unknown }).code === UNDEFINED_COLUMN) return db.from("booking_links").select(COLUMNS).order("created_at", { ascending: false }).limit(limit)
  return first
}

/**
 * The list. With a Calendly client, each link's latest booking is read from Calendly too (booked, or cancelled and by whom); without one every booking
 * is shown as "could not check Calendly". Reading the stored bookings, the cards or Calendly can fail without ever hiding a link.
 */
export async function listLinks(db: Db, now: Date, limit = 100, baseUrl?: string, calendly?: CalendlyCtx): Promise<{ ok: true; links: LinkDto[] } | { ok: false; error: string }> {
  try {
    const { data, error } = await selectLinks(db, limit)
    if (error) return isMissingTable(error) ? { ok: true, links: [] } : { ok: false, error: "The links could not be read. Try again." }
    const rows = (data ?? []) as LinkRow[]

    // the bookings made through these links (the webhook stores every one with the link's id), then what Calendly says about the latest of each
    const stored = await loadStoredBookings(db, rows.map((r) => r.public_id))
    const storedOf = (r: LinkRow) => (stored.ok ? stored.byTag.get(r.public_id) ?? [] : [])
    const urisOf = new Map(rows.map((r) => [r.id, bookingUrisOf(storedOf(r), r.claimed_event_uri)] as const))
    const latest = rows.map((r) => urisOf.get(r.id)?.[0]).filter((u): u is string => !!u)
    const facts: Map<string, EventFacts | null> = calendly && latest.length ? await lookupEvents(calendly, latest) : new Map()
    // who booked: the booker named in the stored delivery of each link's latest booking
    const bookerOf = new Map<string, Booker | null>(
      rows.map((r) => {
        const latestUri = urisOf.get(r.id)?.[0]
        return [r.id, latestUri ? storedOf(r).find((s) => s.eventUri === latestUri)?.booker ?? null : null] as const
      }),
    )
    const cards = await loadLinkCards(db, rows, bookerOf)

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
          who: whoBooked({ personName: r.person_name, personEmails: r.person_emails }, bookerOf.get(r.id) ?? null),
          card: cards.get(r.id) ?? null,
          pay: payDtoOf(r, baseUrl),
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
    if (Array.isArray(data) && data.length > 0) {
      // a PAID link that is stopped must also stop taking money: a card page the person already opened is closed too (best effort, never blocks the stop)
      await stopChargingIfPaidLink(db, id, now)
      return { ok: true, message: "The link is stopped. Anyone opening it now lands on the normal booking page." }
    }
    const { data: row, error: readErr } = await db.from("booking_links").select("status, revoked_at").eq("id", id).maybeSingle()
    if (readErr) return { ok: false, status: 500, error: "The link could not be stopped. Try again." }
    if (!row) return { ok: false, status: 404, error: "That link could not be found." }
    if (row.revoked_at) return { ok: true, message: "The link was already stopped." }
    return { ok: false, status: 409, error: "Someone has already booked with this link, so it cannot be stopped." }
  } catch {
    return { ok: false, status: 500, error: "The link could not be stopped. Try again." }
  }
}
