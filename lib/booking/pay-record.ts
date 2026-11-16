/**
 * Booking page, PAID links — what happens when a link's payment comes in (dev job 74432428). Called by the Stripe payment recorder
 * (lib/incoming-payments/link-payment.ts) the moment it sees `booking_link_id` on the payment. A payment WITHOUT that tag never reaches this file and is recorded
 * exactly as it was before (a test pins that).
 *
 * What is recorded (the same engine the Calendar's "Payments to confirm" and the lead page's payment link use: `settlePayment`):
 *   - on the person the LINK was made for — never on whoever typed their card (the payer's name is not an identity)
 *   - credit mode:       a Paid invoice + a credit of the same amount toward the person's next new service
 *   - revenue-only mode: the Paid invoice + a credit born used up (this is how "revenue only" is recorded everywhere in the system: no bare invoice exists)
 *   - a SECOND payment on the same link (a different Stripe session) is recorded as revenue only and reported loudly, never as a second credit
 * Then the link is marked paid (first payment wins), which is what clears the card on the Booking page.
 * Never silent: a payment for a link marked "Not charging" / stopped, a second payment, a different amount, and a payment recorded on a DIFFERENT contact than the link's
 * (the recorder finds people by email) are each reported as a system error.
 * Known and accepted (documented in docs/systems/booking.md): the credit-or-revenue-only choice is read from the live link on every delivery, so two payments of two different
 * sessions processed at the very same moment could both book a credit (two sessions on one link cannot normally exist: pay-session.ts makes at most one live page).
 * THROWS when the payment could not be recorded, so the Stripe webhook answers 500 and Stripe sends it again: the money must never exist only in the event log.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { settlePayment, UUID_RE, type Resolution } from "@/lib/incoming-payments/confirm"
import type { WaitingPayment } from "@/lib/incoming-payments/classify"
import { parsePayMode } from "@/lib/booking/payment"
import { contactEmailSet } from "@/lib/operations/contact-email-aliases"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- booking_links: untyped until the production migration is applied
type Db = any

export interface BookingPaySession {
  id: string
  payment_intent: string | null
  amount_total: number | null
  currency: string | null
  customer_details: { email: string | null; name: string | null } | null
  metadata: Record<string, string> | null
}

export interface PayRecordDeps {
  db?: Db
  now?: Date
  settle?: typeof settlePayment
  reportError?: (message: string, context: Record<string, unknown>) => Promise<void>
}

async function defaultReport(message: string, context: Record<string, unknown>): Promise<void> {
  const { reportSystemError } = await import("@/lib/system-errors")
  await reportSystemError({ source: "server", route: "/api/webhooks/stripe", message, context })
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

/**
 * `handled: false` = this payment names a link that does not exist (it was deleted): the caller records it the old way, by the payer's email, and a system error says so.
 * `handled: true` = recorded on the link's person and the link is marked paid.
 */
export async function recordBookingLinkPayment(session: BookingPaySession, deps: PayRecordDeps = {}): Promise<{ handled: boolean }> {
  const db = deps.db ?? supabaseAdmin
  const now = deps.now ?? new Date()
  const settle = deps.settle ?? settlePayment
  const report = deps.reportError ?? defaultReport

  const linkId = text(session.metadata?.booking_link_id)
  if (!linkId || !UUID_RE.test(linkId)) return { handled: false }

  const cents = Number(session.amount_total)
  const currency = String(session.currency ?? "").toUpperCase()
  if (!Number.isFinite(cents) || cents <= 0 || (currency !== "EUR" && currency !== "USD")) {
    throw new Error(`booking-link payment ${session.id}: unusable amount or currency (${session.amount_total} ${session.currency})`)
  }

  const { data: row, error } = await db.from("booking_links").select("id, public_id, contact_id, lead_id, pay_amount_cents, pay_currency, pay_mode, paid_session_id, not_charging_at, revoked_at").eq("id", linkId).maybeSingle()
  // a lookup that FAILS is not "no such link": answer 500 so Stripe sends it again
  if (error) throw new Error(`booking-link payment ${session.id}: could not read the link (${String(error.message ?? "lookup failed")})`)
  if (!row) {
    await report(`A payment came in for a booking link that no longer exists (Stripe session ${session.id}). It was recorded by the payer's email instead.`, { session_id: session.id, booking_link_id: linkId }).catch(() => undefined)
    return { handled: false }
  }

  const otherSession = typeof row.paid_session_id === "string" && row.paid_session_id !== "" && row.paid_session_id !== session.id
  const mode = parsePayMode(row.pay_mode)
  const resolution: Resolution = mode === "credit" && !otherSession ? "paid_call" : "paid_call_already_deducted"

  // the amount Stripe took is what is recorded (it is real money); a difference from the link's price is reported, never hidden
  if (row.pay_amount_cents !== Math.round(cents) || String(row.pay_currency ?? "").toUpperCase() !== currency) {
    await report(`A booking-link payment differs from the link's price (link ${row.pay_amount_cents} ${row.pay_currency}, paid ${Math.round(cents)} ${currency}). The paid amount was recorded.`, { session_id: session.id, booking_link_id: linkId }).catch(() => undefined)
  }
  // Money that arrives for a call Antonio said was NOT to be charged (or whose link he stopped) is real money: it is recorded, but never silently.
  if (row.not_charging_at || row.revoked_at) {
    await report(`A payment came in for a booking link marked "Not charging" or stopped (Stripe session ${session.id}). It was recorded as a normal paid call: refund it in Stripe if it should not have been taken.`, { session_id: session.id, booking_link_id: linkId }).catch(() => undefined)
  }
  if (otherSession) {
    await report(`A second payment came in for a booking link that was already paid (first ${row.paid_session_id}, now ${session.id}). It was recorded as revenue only: check it and refund one if it is a double payment.`, { session_id: session.id, booking_link_id: linkId }).catch(() => undefined)
  }

  // who the payment belongs to: the person the link was made for (a contact's own email, read now), else the email we put on the card page, else whoever paid
  let email: string | null = null
  if (row.contact_id) {
    const { data: c, error: cErr } = await db.from("contacts").select("email, email_2, alt_emails").eq("id", row.contact_id).maybeSingle()
    if (cErr) throw new Error(`booking-link payment ${session.id}: could not read the contact (${String(cErr.message ?? "lookup failed")})`)
    // the primary email, or (a contact with none) the first other address they are known by: never a new contact on the booker's address
    email = c ? contactEmailSet(c)[0] ?? null : null
  }
  email = email ?? text(session.metadata?.client_email) ?? text(session.customer_details?.email)

  const payment: WaitingPayment = {
    sessionId: session.id,
    paymentIntentId: session.payment_intent,
    paymentLinkId: null,
    amount: Math.round(cents) / 100,
    currency,
    email,
    // the name a NEW contact would be created with: the person's own name (put on the card page when it was made), never the name on the card
    name: text(session.metadata?.client_name) ?? text(session.customer_details?.name),
    paidAt: now.toISOString(),
  }
  const leadId = !row.contact_id && typeof row.lead_id === "string" && UUID_RE.test(row.lead_id) ? row.lead_id : null

  let r = await settle({ payment, resolution, leadId, actor: "booking link (paid call)" })
  // the lead was deleted after the link was made: the money still has to be recorded, by the email
  if (!r.ok && r.status === 404 && leadId) r = await settle({ payment, resolution, leadId: null, actor: "booking link (paid call)" })
  if (!r.ok) throw new Error(`booking-link payment ${session.id}: ${r.error}`)

  // The recorder finds the person BY EMAIL. If two contacts share an address (a family company), or the address matches another contact, the money can land on someone other than
  // the person the link was made for. It is already recorded and cannot be moved from here, so say so loudly instead of letting the header's promise be silently untrue.
  if (row.contact_id && r.contactId && r.contactId !== row.contact_id) {
    await report(`A booking-link payment was recorded on a DIFFERENT contact than the one the link was made for (link contact ${row.contact_id}, recorded on ${r.contactId}, Stripe session ${session.id}). The email is probably shared by two contacts: move the invoice and credit to the right one.`, { session_id: session.id, booking_link_id: linkId, link_contact_id: row.contact_id, recorded_contact_id: r.contactId }).catch(() => undefined)
  }

  // mark the link paid (the first payment wins; a redelivery of the same session is a no-op)
  const { error: markErr } = await db.from("booking_links").update({ paid_session_id: session.id, paid_at: now.toISOString(), updated_at: now.toISOString() }).eq("id", linkId).is("paid_session_id", null)
  if (markErr) throw new Error(`booking-link payment ${session.id}: recorded, but the link could not be marked paid (${String(markErr.message ?? "update failed")})`)
  return { handled: true }
}
