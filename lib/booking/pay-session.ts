/**
 * Booking page, PAID links — the payment page's brain (dev job 74432428). Used by the public page /pay/b/<code> (no login: the code is the key).
 *
 * The address Antonio sends never expires: it is OUR page, and the Stripe card page is made only when the payer clicks Pay (Stripe's own pages die after 24 hours).
 *   - a live card page we made earlier is REUSED (so a second click, or opening the link on two devices, never makes a second one)
 *   - a short lease (30 seconds) on the row stops two clicks at the same moment from making two
 *   - if Stripe cannot be asked about the earlier card page, nothing new is made (a parallel one could be paid twice)
 *   - a paid link, a link marked "Not charging" or a call that Calendly says is cancelled never makes a card page
 * The payer's email is pre-filled from the PERSON the link is for (never typed by the payer into our records): the paid call and its credit are recorded on that person.
 * Every function takes its database / Stripe / Calendly client as an argument and never throws.
 */

import { isStrictLinkId } from "@/lib/booking-links/id"
import { isMissingTable } from "@/lib/booking-links/missing-table"
import { bookingUrisOf, decideBooking, isCancelledState, loadStoredBookings, lookupEvents } from "@/lib/booking/link-bookings"
import { createMarketingCheckoutSession, expireCheckoutSession, readCheckoutSession } from "@/lib/stripe-checkout"
import { isPaidLink, isPlainEmail, parsePayMode, payStateOf } from "@/lib/booking/payment"
import { contactEmailSet } from "@/lib/operations/contact-email-aliases"
import type { CalendlyCtx } from "@/lib/calendly/api"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- booking_links: untyped until the production migration is applied
type Db = any

export const DEFAULT_PAY_LABEL = "Strategic call"
/**
 * Where a person may be sent from the payment page: a Stripe card page, nothing else. https only, and the host must be stripe.com itself or one of its sub-domains
 * (checkout.stripe.com today; a Stripe-hosted custom domain would still end in .stripe.com). A look-alike such as checkout.stripe.com.evil.example is refused.
 * (A next.js route file may not export extra names, so this lives here.)
 */
export function isStripePageUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false
  try {
    const u = new URL(raw)
    return u.protocol === "https:" && u.port === "" && u.username === "" && u.password === "" && (u.hostname === "stripe.com" || u.hostname.endsWith(".stripe.com"))
  } catch {
    return false
  }
}
/** the lease that stops two clicks at the same moment from making two card pages */
export const LEASE_MS = 30_000

export interface PayRow {
  id: string
  public_id: string
  contact_id: string | null
  lead_id: string | null
  person_name: string | null
  person_emails: string[] | null
  claimed_event_uri: string | null
  revoked_at: string | null
  pay_amount_cents: number | null
  pay_currency: string | null
  pay_label: string | null
  pay_mode: string | null
  pay_code: string | null
  stripe_session_id: string | null
  session_expires_at: string | null
  session_claim_at: string | null
  paid_session_id: string | null
  not_charging_at: string | null
}

const PAY_COLUMNS =
  "id, public_id, contact_id, lead_id, person_name, person_emails, claimed_event_uri, revoked_at, pay_amount_cents, pay_currency, pay_label, pay_mode, pay_code, stripe_session_id, session_expires_at, session_claim_at, paid_session_id, not_charging_at"

export type PayLookup = { state: "found"; row: PayRow } | { state: "none" } | { state: "error" }

/** Finds a paid link by its pay code. Only a code of our exact shape is looked up; a link that is not a paid link is "none". */
export async function findPayLink(db: Db, code: unknown): Promise<PayLookup> {
  if (!isStrictLinkId(code)) return { state: "none" }
  try {
    const { data, error } = await db.from("booking_links").select(PAY_COLUMNS).eq("pay_code", code).maybeSingle()
    if (error) return isMissingTable(error) || (error as { code?: unknown }).code === "42703" ? { state: "none" } : { state: "error" }
    if (!data) return { state: "none" }
    const row = { ...(data as PayRow), person_emails: Array.isArray((data as PayRow).person_emails) ? (data as PayRow).person_emails : [] }
    return isPaidLink(row) ? { state: "found", row } : { state: "none" }
  } catch {
    return { state: "error" }
  }
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

/**
 * The email the payment is recorded on: the person the link is FOR. A contact's own primary email, a lead's email, else (a link for someone new) the email of whoever BOOKED
 * (read from the stored booking: the email Antonio typed can have a typo), else the first email the link was made with. null = nobody is known; Stripe then asks the payer,
 * and the payer's email is used (as for any payment link).
 */
export async function identityEmail(db: Db, row: PayRow): Promise<string | null> {
  try {
    if (row.contact_id) {
      // the contact's own primary email; a contact with no primary email is known by another address (email_2, an alternate): the first of those
      const { data } = await db.from("contacts").select("email, email_2, alt_emails").eq("id", row.contact_id).maybeSingle()
      const e = data ? contactEmailSet(data)[0] : undefined
      if (e) return e
    }
    if (row.lead_id) {
      const { data } = await db.from("leads").select("email").eq("id", row.lead_id).maybeSingle()
      const e = text(data?.email)
      if (e) return e.toLowerCase()
    }
    // A link made for SOMEONE NEW: the email Antonio typed may have a typo, and the booker may have used another address; whoever actually BOOKED is the person, so
    // the stored booking comes first. Only when nobody has booked yet is the typed email used.
    const stored = await loadStoredBookings(db, [row.public_id])
    if (stored.ok) {
      const b = (stored.byTag.get(row.public_id) ?? []).map((s) => s.booker?.email).find((e): e is string => !!e)
      if (b) return b.toLowerCase()
    }
    const first = (row.person_emails ?? []).map((e) => text(e)).find((e): e is string => !!e)
    if (first) return first.toLowerCase()
  } catch {
    /* fall through: the payer's own email is used */
  }
  return null
}

/**
 * The name a NEW contact would be created with when nobody in the system matches the email: the name the link was made with, else the name of whoever booked
 * (from the stored booking) — never the name on the card (the Aug-5 booking was paid on a card belonging to someone else entirely).
 */
export async function identityName(db: Db, row: PayRow): Promise<string | null> {
  const own = text(row.person_name)
  if (own) return own.slice(0, 100)
  try {
    const stored = await loadStoredBookings(db, [row.public_id])
    if (stored.ok) {
      const b = (stored.byTag.get(row.public_id) ?? []).map((s) => s.booker?.name).find((n): n is string => !!n)
      if (b) return b.slice(0, 100)
    }
  } catch {
    /* fall through: the payer's own name is used */
  }
  return null
}

/** Does Calendly say this link's latest booking is cancelled? Anything we cannot find out counts as "no" (a payment must never be blocked by a slow Calendly). */
export async function isCallCancelled(db: Db, row: PayRow, calendly: CalendlyCtx | undefined): Promise<boolean> {
  if (!calendly) return false
  try {
    const stored = await loadStoredBookings(db, [row.public_id])
    if (!stored.ok) return false
    const bookings = stored.byTag.get(row.public_id) ?? []
    const uris = bookingUrisOf(bookings, row.claimed_event_uri)
    if (!uris.length) return false
    const facts = await lookupEvents(calendly, [uris[0]])
    const found = decideBooking({ uris, stored: bookings, facts })
    return !!found && isCancelledState(found.state)
  } catch {
    return false
  }
}

export interface StripeOps {
  create: typeof createMarketingCheckoutSession
  read: typeof readCheckoutSession
  /** closes a card page (a page that could not be saved on the link is closed at once) */
  expire: typeof expireCheckoutSession
}

export interface OpenDeps {
  db: Db
  now?: Date
  calendly?: CalendlyCtx
  stripe?: StripeOps
}

export type NoReason = "none" | "paid" | "stopped" | "cancelled" | "busy" | "stripe" | "error"

export type OpenResult = { ok: true; url: string } | { ok: false; reason: NoReason; message: string }

export const SAYS: Record<NoReason, string> = {
  none: "This payment link is not valid. Please ask the person who sent it for a new one.",
  paid: "This payment was already received. Thank you.",
  stopped: "This payment is no longer needed. Nothing is due.",
  cancelled: "This call was cancelled, so nothing is due.",
  busy: "We are opening the payment page. Please press the button again in a few seconds.",
  stripe: "The payment page could not be opened right now. Please try again in a minute.",
  error: "We could not open this payment link right now. Please try again in a minute.",
}

const no = (reason: NoReason): OpenResult => ({ ok: false, reason, message: SAYS[reason] })

/** The one function behind the Pay button: finds or makes the card page and returns its address. */
export async function openPayment(deps: OpenDeps, code: unknown): Promise<OpenResult> {
  const { db } = deps
  const now = deps.now ?? new Date()
  const stripe: StripeOps = deps.stripe ?? { create: createMarketingCheckoutSession, read: readCheckoutSession, expire: expireCheckoutSession }

  const found = await findPayLink(db, code)
  if (found.state === "none") return no("none")
  if (found.state === "error") return no("error")
  const row = found.row

  const state = payStateOf(row)
  if (state === "paid") return no("paid")
  if (state === "not_charging" || row.revoked_at) return no("stopped")
  if (await isCallCancelled(db, row, deps.calendly)) return no("cancelled")

  // A card page we made earlier: reuse it while it is open. If we cannot ask Stripe, make nothing (a second page could be paid as well).
  if (row.stripe_session_id) {
    const s = await stripe.read(row.stripe_session_id)
    if (!s.ok) return no("stripe")
    // still open: reuse it; if Stripe gave no address for an open page, make NOTHING (a second live page could be paid as well)
    if (s.status === "open") return s.url ? { ok: true, url: s.url } : no("stripe")
    if (s.status === "complete") return no("paid")
    // expired (or gone): a new one is made below
  }

  // the lease: only one click at a time may make the card page
  const leaseCutoff = new Date(now.getTime() - LEASE_MS).toISOString()
  try {
    let q = db.from("booking_links").update({ session_claim_at: now.toISOString() }).eq("id", row.id).is("paid_session_id", null).is("not_charging_at", null).or(`session_claim_at.is.null,session_claim_at.lt.${leaseCutoff}`)
    q = row.stripe_session_id ? q.eq("stripe_session_id", row.stripe_session_id) : q.is("stripe_session_id", null)
    const { data, error } = await q.select("id")
    if (error) return no("error")
    if (!Array.isArray(data) || data.length === 0) return no("busy")
  } catch {
    return no("error")
  }

  const [email, name] = await Promise.all([identityEmail(db, row), identityName(db, row)])
  const amountCents = row.pay_amount_cents as number
  const currency = row.pay_currency as "USD" | "EUR"
  const metadata: Record<string, string> = {
    payment_kind: "paid_call",
    booking_link_id: row.id,
    pay_mode: parsePayMode(row.pay_mode),
    ...(email ? { client_email: email } : {}),
    ...(name ? { client_name: name } : {}),
    ...(row.lead_id ? { crm_lead_ref: row.lead_id } : {}),
  }
  // The card page's email is prefilled only with a PLAIN address: Stripe rejects a malformed one, which would make the link permanently unpayable (staff-typed CRM emails are not always clean).
  const made = await stripe.create({ amountCents, currency, productName: text(row.pay_label) ?? DEFAULT_PAY_LABEL, clientEmail: isPlainEmail(email) ? email : null, metadata })
  if (!made.success || !made.checkoutUrl || !made.sessionId) {
    await releaseLease(db, row.id)
    return no("stripe")
  }
  // Remember the new card page. The save is conditioned on OUR lease (so a slow click cannot overwrite a newer page) and on the link still being payable (so a "Not charging"
  // pressed meanwhile is honoured). If it does not save, the card page that was just made is CLOSED: a page the link does not know about could never be stopped, and the next
  // click would make a second payable one (a double charge).
  let saved = false
  try {
    const { data, error } = await db
      .from("booking_links")
      .update({ stripe_session_id: made.sessionId, session_expires_at: made.expiresAt ? made.expiresAt.toISOString() : null, session_claim_at: null, updated_at: now.toISOString() })
      .eq("id", row.id)
      .eq("session_claim_at", now.toISOString())
      .is("paid_session_id", null)
      .is("not_charging_at", null)
      .select("id")
    saved = !error && Array.isArray(data) && data.length > 0
    if (error) await releaseLease(db, row.id)
  } catch {
    saved = false
  }
  if (!saved) {
    await stripe.expire(made.sessionId).catch(() => undefined)
    return no("error")
  }
  return { ok: true, url: made.checkoutUrl }
}

async function releaseLease(db: Db, id: string): Promise<void> {
  try {
    await db.from("booking_links").update({ session_claim_at: null }).eq("id", id)
  } catch {
    /* the lease runs out by itself after 30 seconds */
  }
}
