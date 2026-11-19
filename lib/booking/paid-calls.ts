/**
 * Booking page, PAID links — the "unpaid call" cards in "Calls to check" (dev job 74432428).
 *
 * These cards are WORKED OUT every time the page opens, never stored, so they can never be stale:
 *   a card exists while  the link has a price  AND  someone booked it (the stored booking, checked against Calendly)  AND  the booking is not cancelled
 *                        AND  the payment has not come in  AND  Antonio has not said "Not charging".
 *   After "I sent it" the card waits, and comes back the day before the call (or at once if the call is less than a day away).
 * That also means it works in every Booking mode (the page's "page" mode never claims a link in the webhook, but every booking is stored), and a call cancelled in
 * Calendly itself drops its card by itself. A booking Calendly could not be asked about still shows the card, with a plain warning.
 *
 * A failed read is reported as a failure (the Booking page must never say "nothing needs you" because a read broke); a database without the payment columns yet
 * (the code is deployed before the migration) simply has no paid links.
 */

import { isMissingTable } from "@/lib/booking-links/missing-table"
import { isItalian } from "@/lib/locale"
import { bookingUrisOf, decideBooking, loadStoredBookings, lookupEvents, canCancelBooking, type EventFacts, type LinkBooking, type StoredBooking } from "@/lib/booking/link-bookings"
import { isPaidLink, moneyText, parsePayMode, payModeText, payStateOf, payUrl, paymentDraft } from "@/lib/booking/payment"
import { nyWhen } from "@/lib/booking/links"
import type { CardDto, LoadChecks } from "@/lib/booking/checks"
import type { CalendlyCtx } from "@/lib/calendly/api"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- booking_links: untyped until the production migration is applied
type Db = any

export interface PaidLinkRow {
  id: string
  public_id: string
  contact_id: string | null
  person_name: string | null
  person_emails: string[] | null
  person_language: string | null
  claimed_event_uri: string | null
  pay_amount_cents: number | null
  pay_currency: string | null
  pay_label: string | null
  pay_mode: string | null
  pay_code: string | null
  sent_at: string | null
  sent_count: number | null
  paid_session_id: string | null
  not_charging_at: string | null
}

const COLUMNS = "id, public_id, contact_id, person_name, person_emails, person_language, claimed_event_uri, pay_amount_cents, pay_currency, pay_label, pay_mode, pay_code, sent_at, sent_count, paid_session_id, not_charging_at"
const DAY_MS = 24 * 60 * 60 * 1000
const PAID_LOOKUP_MAX = 100

/** Contacts on these portal levels are portal clients: their payment link is copied into the portal chat by hand, never emailed from here. */
export const PORTAL_TIERS = ["formation", "onboarding", "active"]

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

/**
 * Should the card be on screen now? Never sent: yes. Sent: from the day before the call; a call with no known time comes back a day after it was sent
 * (an unpaid call must never vanish for good). PURE.
 */
export function cardIsDue(sentAt: string | null, startTime: string | null, now: Date): boolean {
  if (!sentAt) return true
  if (!startTime) return now.getTime() >= new Date(sentAt).getTime() + DAY_MS
  return now.getTime() >= new Date(startTime).getTime() - DAY_MS
}

/** One card, or null when nothing needs Antonio. PURE: everything it needs is passed in. */
export function decidePaidCard(input: {
  row: PaidLinkRow
  /** the link's latest booking, as decideBooking read it; null = nobody booked */
  booking: LinkBooking | null
  stored: StoredBooking[]
  copyOnly: boolean
  now: Date
  baseUrl?: string
}): CardDto | null {
  const { row, booking, now } = input
  if (!isPaidLink(row) || payStateOf(row) !== "unpaid") return null
  if (!booking || !canCancelBooking(booking.state)) return null
  if (!cardIsDue(row.sent_at, booking.startTime, now)) return null

  const latest = input.stored.find((s) => s.eventUri === booking.eventUri)?.booker ?? null
  const who = text(latest?.name) ?? text(row.person_name) ?? text(latest?.email) ?? text(row.person_emails?.[0]) ?? "Someone"
  const email = text(latest?.email) ?? text(row.person_emails?.[0])
  const money = moneyText(row.pay_amount_cents as number, row.pay_currency as string)
  const url = payUrl(row.pay_code as string, input.baseUrl)
  const when = booking.startTime ? nyWhen(booking.startTime) : null
  const language = isItalian(row.person_language) ? "Italian" : "English"
  const sentCount = row.sent_count ?? 0

  const notes: string[] = []
  if (booking.state === "booked_unchecked") notes.push("Calendly could not be checked, so this call may have been cancelled.")
  if (input.copyOnly) notes.push("This is a portal client: copy the payment link and send it in their portal chat yourself.")
  if (row.sent_at) {
    const past = !!booking.startTime && new Date(booking.startTime).getTime() < now.getTime()
    notes.push(`You marked the payment link as sent on ${nyWhen(row.sent_at)}${sentCount > 1 ? ` (${sentCount} times)` : ""}. ${past ? "It is back because the call has passed and nothing was paid." : "It is back because the call is close."}`)
  }

  return {
    id: `paid-${row.id}`,
    kind: "unpaid_call",
    question: `${who} booked a paid call. Not paid yet.`,
    why: `${money}${row.pay_label ? ` · ${row.pay_label}` : ""}. ${payModeText(parsePayMode(row.pay_mode))}`,
    note: notes.length ? notes.join(" ") : null,
    answers: [],
    madeAt: row.sent_at ?? new Date(now).toISOString(),
    callAt: booking.startTime,
    paid: {
      linkId: row.id,
      amountText: money,
      payUrl: url,
      email,
      draft: paymentDraft({ language, name: text(latest?.name) ?? text(row.person_name), amountText: money, url, when }),
      copyOnly: input.copyOnly,
      sentAt: row.sent_at,
      sentCount,
    },
  }
}

export type LoadPaidCalls = { ok: true; cards: CardDto[] } | { ok: false; error: string }

/** The cards of "Calls to check": unpaid calls first (they are money), then the bookings that need a look. If EITHER read failed the answer is a failure, never a shorter list. */
export function mergeCards(checks: LoadChecks, paid: LoadPaidCalls): LoadChecks {
  if (!checks.ok) return checks
  if ("error" in paid) return { ok: false, error: paid.error }
  const cards = [...paid.cards, ...checks.cards]
  return { ok: true, cards, count: cards.length }
}

/** Every unpaid paid call that needs a look now. Reading the stored bookings or the contacts can fail (said plainly); Calendly being slow or down never hides a card. */
export async function loadPaidCalls(db: Db, now: Date, calendly?: CalendlyCtx, baseUrl?: string): Promise<LoadPaidCalls> {
  try {
    const { data, error } = await db
      .from("booking_links")
      .select(COLUMNS)
      .not("pay_amount_cents", "is", null)
      .is("paid_session_id", null)
      .is("not_charging_at", null)
      .is("revoked_at", null)
      .order("created_at", { ascending: false })
      .limit(200)
    if (error) return isMissingTable(error) || (error as { code?: unknown }).code === "42703" ? { ok: true, cards: [] } : { ok: false, error: "The unpaid calls could not be read." }
    const rows = ((data ?? []) as PaidLinkRow[]).filter((r) => isPaidLink(r)).map((r) => ({ ...r, person_emails: Array.isArray(r.person_emails) ? r.person_emails : [] }))
    if (rows.length === 0) return { ok: true, cards: [] }

    const stored = await loadStoredBookings(db, rows.map((r) => r.public_id))
    if (!stored.ok) return { ok: false, error: "The unpaid calls could not be read." }
    const storedOf = (r: PaidLinkRow) => stored.byTag.get(r.public_id) ?? []
    const urisOf = new Map(rows.map((r) => [r.id, bookingUrisOf(storedOf(r), r.claimed_event_uri)] as const))
    const latest = rows.map((r) => urisOf.get(r.id)?.[0]).filter((u): u is string => !!u)
    // Every unpaid paid call is asked about (up to 100, not the usual 25): an unpaid call cancelled by the booker in Calendly is never reported to us, so a call that is not asked
    // about would come back as a false "could not be checked" card.
    const facts: Map<string, EventFacts | null> = calendly && latest.length ? await lookupEvents(calendly, latest, PAID_LOOKUP_MAX) : new Map()

    // portal clients: copy the link by hand. A contact whose level cannot be read is treated as a portal client (the safe side: nothing is offered to be emailed).
    const contactIds = Array.from(new Set(rows.map((r) => r.contact_id).filter((x): x is string => !!x)))
    const portal = new Map<string, boolean>()
    if (contactIds.length) {
      const { data: cs, error: cErr } = await db.from("contacts").select("id, portal_tier").in("id", contactIds)
      for (const id of contactIds) portal.set(id, !!cErr)
      if (!cErr) for (const c of (cs ?? []) as Array<{ id: string; portal_tier: string | null }>) portal.set(c.id, !!c.portal_tier && PORTAL_TIERS.includes(c.portal_tier))
    }

    const cards: CardDto[] = []
    for (const r of rows) {
      const booking = decideBooking({ uris: urisOf.get(r.id) ?? [], stored: storedOf(r), facts })
      const card = decidePaidCard({ row: r, booking, stored: storedOf(r), copyOnly: r.contact_id ? portal.get(r.contact_id) ?? true : false, now, baseUrl })
      if (card) cards.push(card)
    }
    return { ok: true, cards }
  } catch {
    return { ok: false, error: "The unpaid calls could not be read." }
  }
}
