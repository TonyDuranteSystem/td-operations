/**
 * Booking page, PAID links — what the buttons on an "unpaid call" card do (dev job 74432428): "I sent it" and "Not charging". The database client is passed in;
 * nothing throws; every answer is plain words (R099).
 *
 *   markPaymentSent   remembers that the payment link was sent (the card then waits until the day before the call). Safe to press twice.
 *   stopCharging      "Not charging": the card closes and the payment page stops taking money; the Stripe card page (if one was made) is closed too, best effort.
 *                     A link that is already paid cannot be stopped (the money is real). Also used when the call is cancelled from this page.
 */

import { expireCheckoutSession } from "@/lib/stripe-checkout"
import { isPaidLink } from "@/lib/booking/payment"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- booking_links: untyped until the production migration is applied
type Db = any

export type PayActionResult = { ok: true; message: string } | { ok: false; status: number; error: string }

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const NOT_FOUND: PayActionResult = { ok: false, status: 404, error: "That link could not be found." }
const NOT_PAID_LINK: PayActionResult = { ok: false, status: 409, error: "This link has no payment on it." }

interface PayRow {
  pay_amount_cents: number | null
  pay_currency: string | null
  pay_code: string | null
  paid_session_id: string | null
  not_charging_at: string | null
  stripe_session_id: string | null
  sent_count: number | null
}

/** One flat shape (this project's TypeScript setup does not narrow a union on `ok`): `row` is set, or `result` says why not. */
async function readRow(db: Db, id: string): Promise<{ row: PayRow | null; result: PayActionResult | null }> {
  try {
    const { data, error } = await db.from("booking_links").select("pay_amount_cents, pay_currency, pay_code, paid_session_id, not_charging_at, stripe_session_id, sent_count").eq("id", id).maybeSingle()
    if (error) return { row: null, result: { ok: false, status: 500, error: "The link could not be read. Try again." } }
    if (!data) return { row: null, result: NOT_FOUND }
    const row = data as PayRow
    if (!isPaidLink(row)) return { row: null, result: NOT_PAID_LINK }
    return { row, result: null }
  } catch {
    return { row: null, result: { ok: false, status: 500, error: "The link could not be read. Try again." } }
  }
}

export async function markPaymentSent(db: Db, id: string, now: Date): Promise<PayActionResult> {
  if (!UUID.test(id)) return NOT_FOUND
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await readRow(db, id)
    if (!r.row) return r.result as PayActionResult
    if (r.row.paid_session_id) return { ok: false, status: 409, error: "This call is already paid." }
    if (r.row.not_charging_at) return { ok: false, status: 409, error: "This call was marked as not charging." }
    const n = r.row.sent_count ?? 0
    try {
      const { data, error } = await db
        .from("booking_links")
        .update({ sent_at: now.toISOString(), sent_count: n + 1, updated_at: now.toISOString() })
        .eq("id", id)
        .eq("sent_count", n)
        .is("paid_session_id", null)
        .select("id")
      if (error) return { ok: false, status: 500, error: "That could not be saved. Try again." }
      if (Array.isArray(data) && data.length > 0) return { ok: true, message: "Marked as sent. The card comes back the day before the call if it is still unpaid." }
    } catch {
      return { ok: false, status: 500, error: "That could not be saved. Try again." }
    }
    // someone else changed the count a moment ago: read again and retry
  }
  return { ok: false, status: 409, error: "Someone else changed this at the same moment. Reload the page." }
}

const EXPIRE_TIMEOUT_MS = 8_000

/** Gives a Stripe call a deadline: past it the answer is "could not close", never a hang. */
async function withTimeout(p: Promise<{ ok: boolean; error?: string }>, ms: number): Promise<{ ok: boolean; error?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([p, new Promise<{ ok: boolean; error?: string }>((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: "slow" }), ms) })])
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface StopDeps {
  /** closes the Stripe card page; injectable for tests */
  expire?: (sessionId: string) => Promise<{ ok: boolean; error?: string }>
}

export async function stopCharging(db: Db, id: string, now: Date, deps: StopDeps = {}): Promise<PayActionResult> {
  if (!UUID.test(id)) return NOT_FOUND
  const r = await readRow(db, id)
  if (!r.row) return r.result as PayActionResult
  if (r.row.paid_session_id) return { ok: false, status: 409, error: "This call is already paid, so it cannot be marked as not charging." }
  if (r.row.not_charging_at) return { ok: true, message: "This call was already marked as not charging." }
  // The card page to close is the one the UPDATE itself returns: a Pay click that saved a new page between the read above and this update is then closed too (not the stale one).
  let sessionToClose: string | null = r.row.stripe_session_id
  try {
    const { data, error } = await db
      .from("booking_links")
      .update({ not_charging_at: now.toISOString(), updated_at: now.toISOString() })
      .eq("id", id)
      .is("paid_session_id", null)
      .is("not_charging_at", null)
      .select("id, stripe_session_id")
    if (error) return { ok: false, status: 500, error: "That could not be saved. Try again." }
    if (!Array.isArray(data) || data.length === 0) {
      // paid, or stopped by someone else, a moment ago: say which
      const again = await readRow(db, id)
      if (again.row && again.row.paid_session_id) return { ok: false, status: 409, error: "This call was just paid, so it cannot be marked as not charging." }
      return { ok: true, message: "This call was already marked as not charging." }
    }
    const saved = (data[0] as { stripe_session_id?: unknown }).stripe_session_id
    if (typeof saved === "string" && saved) sessionToClose = saved
  } catch {
    return { ok: false, status: 500, error: "That could not be saved. Try again." }
  }
  // close the card page so nobody can still pay by an old tab (best effort: the payment page also refuses from now on)
  let note = ""
  if (sessionToClose) {
    // Stripe is given 8 seconds: a hung Stripe call must never turn a finished "Not charging" (or an already-sent Calendly cancel) into a timeout on the page
    const closed = await withTimeout((deps.expire ?? expireCheckoutSession)(sessionToClose), EXPIRE_TIMEOUT_MS)
    if (!closed.ok) note = " The card page could not be closed in Stripe, but the payment page no longer takes money."
  }
  return { ok: true, message: `Marked as not charging. The payment link no longer takes money.${note}` }
}

/** After a call is cancelled from the Booking page: if its link carried a price that was never paid, stop charging for it. Never throws, never blocks the cancel. */
export async function stopChargingIfPaidLink(db: Db, id: string, now: Date, deps: StopDeps = {}): Promise<void> {
  try {
    const r = await readRow(db, id)
    if (!r.row || r.row.paid_session_id || r.row.not_charging_at) return
    await stopCharging(db, id, now, deps)
  } catch {
    /* the payment page also checks Calendly before it takes money */
  }
}
