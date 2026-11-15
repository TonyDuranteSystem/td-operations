/**
 * Booking page, PAID links — the payment page the person opens from Antonio's message: /pay/b/<code> (dev job 74432428).
 * Under /pay, which is already public (the person has no login; the 128-bit code is the key). Two steps on purpose:
 *   GET   shows what is due and a Pay button. It changes NOTHING, so a mail scanner or a chat app unfurling the link never makes a card page.
 *   POST  (the button) makes or reuses the Stripe card page (lib/booking/pay-session.ts) and sends the person there.
 * The page says nothing about who the link is for: only the amount, what it is for and, if known, when the call is.
 * Every answer is not cached, not framed and sends no referrer (the code is in the address). The only place a person is ever sent is a Stripe card page address
 * (checked: it must start with https://checkout.stripe.com/). A "wait" or "try again" answer carries its own button, so a double tap never leaves a dead end.
 */
import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { calendlyCtxFromEnv } from "@/lib/calendly/api"
import { DEFAULT_PAY_LABEL, SAYS, STRIPE_PAGE_PREFIX, findPayLink, openPayment, type NoReason } from "@/lib/booking/pay-session"
import { moneyText, payStateOf } from "@/lib/booking/payment"
import { loadStoredBookings } from "@/lib/booking/link-bookings"
import { nyWhen } from "@/lib/booking/links"

export const dynamic = "force-dynamic"

const HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY" } as const

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")

const HEAD = (title: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>` +
  `<style>body{font-family:Arial,Helvetica,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1rem;color:#1e293b}h1{font-size:1.3rem}.box{border:1px solid #e2e8f0;border-radius:.6rem;padding:1.1rem 1.2rem;margin:1.2rem 0}` +
  `.amt{font-size:1.8rem;font-weight:700;margin:.2rem 0}.muted{color:#64748b;font-size:.9rem}button{background:#0f172a;color:#fff;border:0;border-radius:.5rem;padding:.75rem 1.3rem;font-size:1rem;cursor:pointer;width:100%}</style></head>`

const page = (title: string, bodyHtml: string, status: number): NextResponse =>
  new NextResponse(`${HEAD(title)}<body><h1>${esc(title)}</h1>${bodyHtml}</body></html>`, { status, headers: HEADERS })

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

  // when the call is, if we know (read from the stored booking; Calendly is not asked on this read-only page)
  let when: string | null = null
  const stored = await loadStoredBookings(supabaseAdmin, [row.public_id])
  const start = stored.ok ? stored.byTag.get(row.public_id)?.[0]?.startTime ?? null : null
  if (start) when = nyWhen(start)

  const money = moneyText(row.pay_amount_cents as number, row.pay_currency as string)
  const label = row.pay_label?.trim() || DEFAULT_PAY_LABEL
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
    // only ever Stripe's own page: anything else is refused, whatever the answer said
    if (!r.url.startsWith(STRIPE_PAGE_PREFIX)) return page(TITLE.stripe, `<p>${esc(SAYS.stripe)}</p><form method="post" action=""><button type="submit">Try again</button></form>`, STATUS.stripe)
    return new NextResponse(null, { status: 303, headers: { location: r.url, "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY" } })
  }
  const retry = CAN_RETRY.has(r.reason) ? `<form method="post" action=""><button type="submit">Try again</button></form>` : ""
  return page(TITLE[r.reason], `<p>${esc(r.message)}</p>${retry}`, STATUS[r.reason])
}
