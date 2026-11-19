/**
 * Booking page, PAID links — OUR public page for a paid call: /pay/b/<code> (dev job 74432428). Under /pay, which is already public (the person has no login; the 128-bit code is the key).
 * Antonio, 16 Nov 2026: the person opens the link, books the call and pays, all in our system.
 *   GET   shows one of two views and changes NOTHING (a mail scanner or a chat app unfurling the link never books or pays):
 *           BOOK  nobody has booked yet: free times, name + email, "Book and pay" (the script talks to ./times and ./book; the booking is made there)
 *           PAY   a time is booked and nothing is paid: the amount, the call's time and a "Pay by card" button
 *   POST  (the card button) makes or reuses the Stripe card page (lib/booking/pay-session.ts) and sends the person there.
 * The page says nothing about who the link is for beyond what the person typed or was pre-filled with: the amount, what it is for and, once booked, when the call is.
 * Every answer is not cached, not framed and sends no referrer (the code is in the address). The only place a person is ever sent is a Stripe card page address
 * (checked: https, and the host must be stripe.com or one of its sub-domains). A "wait" or "try again" answer carries its own button, so a double tap never leaves a dead end.
 */
import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { calendlyCtxFromEnv, getScheduledEvent } from "@/lib/calendly/api"
import { DEFAULT_PAY_LABEL, SAYS, findPayLink, isStripePageUrl, openPayment, type NoReason } from "@/lib/booking/pay-session"
import { moneyText, payStateOf } from "@/lib/booking/payment"
import { loadStoredBookings } from "@/lib/booking/link-bookings"
import { linkStatusOf, nyWhen } from "@/lib/booking/links"
import { BOOK_SAYS } from "@/lib/booking/book-and-pay"
import { bookViewHtml, esc, htmlHead } from "@/lib/booking/pay-page-html"

export const dynamic = "force-dynamic"

const HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY" } as const

const page = (title: string, bodyHtml: string, status: number): NextResponse =>
  new NextResponse(`${htmlHead(title)}<body><h1>${esc(title)}</h1>${bodyHtml}</body></html>`, { status, headers: HEADERS })

const STATUS: Record<NoReason, number> = { none: 404, paid: 200, stopped: 410, cancelled: 410, busy: 503, stripe: 502, error: 503 }
const TITLE: Record<NoReason, string> = { none: "Link not found", paid: "Already paid", stopped: "Nothing is due", cancelled: "Nothing is due", busy: "One moment", stripe: "Please try again", error: "Please try again" }
/** The answers after which pressing the button again can work. */
const CAN_RETRY: ReadonlySet<NoReason> = new Set<NoReason>(["busy", "stripe", "error"])

export async function GET(_req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const found = await findPayLink(supabaseAdmin, code)
  if (found.state === "none") return page(TITLE.none, `<p>${esc(SAYS.none)}</p>`, STATUS.none)
  if (found.state === "error") return page(TITLE.error, `<p>${esc(SAYS.error)}</p>`, STATUS.error)
  const row = found.row
  const state = payStateOf(row)
  if (state === "paid") return page(TITLE.paid, `<p>${esc(SAYS.paid)}</p>`, STATUS.paid)
  if (state === "not_charging" || row.revoked_at) return page(TITLE.stopped, `<p>${esc(SAYS.stopped)}</p>`, STATUS.stopped)

  const money = moneyText(row.pay_amount_cents as number, row.pay_currency as string)
  const label = row.pay_label?.trim() || DEFAULT_PAY_LABEL

  // Has somebody booked with this link? Either the link is marked booked (the booking made on this page), or a booking made through Calendly's own page is stored.
  const stored = await loadStoredBookings(supabaseAdmin, [row.public_id])
  let start = stored.ok ? stored.byTag.get(row.public_id)?.[0]?.startTime ?? null : null
  const booked = row.status === "claimed" || !!row.claimed_event_uri || !!start
  if (!booked) {
    // an expired link (the status helper knows) can no longer take a booking
    if (linkStatusOf({ status: row.status ?? "open", revoked_at: row.revoked_at, expires_at: row.expires_at ?? null }, new Date()) !== "open") return page("Link not open", `<p>${esc(BOOK_SAYS.closed)}</p>`, 410)
    const email = (row.person_emails ?? []).find((e) => typeof e === "string" && e.trim()) ?? ""
    const minutes = typeof row.duration_minutes === "number" && row.duration_minutes > 0 ? row.duration_minutes : 30
    return new NextResponse(`${htmlHead("Book and pay")}<body><h1>Book your call</h1>${bookViewHtml({ code, money, label, minutes, name: row.person_name?.trim() ?? "", email: email.trim() })}</body></html>`, { status: 200, headers: HEADERS })
  }

  // booked on this page and the delivery has not arrived yet: ask Calendly when the call is (read only; a failure just leaves the time out)
  if (!start && row.claimed_event_uri) {
    try {
      const ctx = calendlyCtxFromEnv()
      if (ctx.token) start = (await getScheduledEvent(ctx, row.claimed_event_uri)).startTime
    } catch {
      /* the time is a courtesy line: the amount and the button are what matter */
    }
  }
  const when = start ? nyWhen(start) : null
  return page(
    "Pay for your call",
    `<div class="box"><div class="muted">Tony Durante LLC</div><div class="amt">${esc(money)}</div><div>${esc(label)}</div>${when ? `<div class="muted">Your call: ${esc(when)}</div>` : ""}</div>` +
      `<form method="post" action=""><button type="submit">Pay by card</button></form>` +
      `<p class="muted">You will be taken to Stripe, our secure card payment page. Nothing is charged until you confirm there.</p>`,
    200,
  )
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const r = await openPayment({ db: supabaseAdmin, calendly: calendlyCtxFromEnv() }, code)
  if ("url" in r) {
    // only ever a Stripe card page: anything else is refused, whatever the answer said
    if (!isStripePageUrl(r.url)) return page(TITLE.stripe, `<p>${esc(SAYS.stripe)}</p><form method="post" action=""><button type="submit">Try again</button></form>`, STATUS.stripe)
    return new NextResponse(null, { status: 303, headers: { location: r.url, "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY" } })
  }
  const retry = CAN_RETRY.has(r.reason) ? `<form method="post" action=""><button type="submit">Try again</button></form>` : ""
  return page(TITLE[r.reason], `<p>${esc(r.message)}</p>${retry}`, STATUS[r.reason])
}
