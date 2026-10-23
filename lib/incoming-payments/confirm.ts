/**
 * Payments to confirm — what staff's choice does. SERVER-ONLY.
 *
 * Three choices (Phase 1):
 *   paid_call                   record the money as a paid strategy call AND a deductible credit for the person (the normal case).
 *   paid_call_already_deducted  same, but the credit is born used: staff already took the amount off the offer by hand, so the
 *                               system must not deduct it a second time ("revenue only, history kept").
 *   recorded_elsewhere          this payment is already in the books some other way (or is not a client payment): nothing is
 *                               written except the note saying so, and it leaves the waiting list.
 *
 * Nothing about the money is taken from the browser: the amount, currency, payer and Stripe ids are re-read from the saved
 * Stripe event. The lead is NEVER converted and no client record is tagged: a paid call is not a sale (R094).
 *
 * `settlePayment` is the shared core: the Calendar's confirm step uses it, and so does the Stripe webhook for a payment made
 * through a paid-call link created from the CRM (Phase 2), which needs no confirmation because the link itself says what it is.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { recordPaidCall } from "@/lib/operations/paid-call-credit"
import { loadWaitingPaymentBySession } from "@/lib/incoming-payments/load"
import type { WaitingPayment } from "@/lib/incoming-payments/classify"

// The table is not in the generated types yet (it arrives with the next types regeneration).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

export const RESOLUTIONS = ["paid_call", "paid_call_already_deducted", "recorded_elsewhere"] as const
export type Resolution = (typeof RESOLUTIONS)[number]

export function isResolution(v: unknown): v is Resolution {
  return typeof v === "string" && (RESOLUTIONS as readonly string[]).includes(v)
}

/** One flat shape (not a union): this project's TypeScript setup does not narrow a union on `ok`. `ok: false` always carries `status` + `error`. */
export interface ConfirmResult {
  ok: boolean
  resolution?: Resolution
  alreadySettled?: boolean
  invoiceNumber?: string
  creditNumber?: string | null
  contactId?: string
  status?: number
  error?: string
}

const SESSION_ID_RE = /^cs_[A-Za-z0-9_]{8,200}$/
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Record one payment and settle its session. Idempotent: the invoice/credit are keyed on the session and the resolution table's
 * primary key is the session id, so a retry (Stripe redelivery, double click) never records anything twice.
 */
export async function settlePayment(input: {
  payment: WaitingPayment
  resolution: Resolution
  leadId?: string | null
  note?: string | null
  actor: string
}): Promise<ConfirmResult> {
  const { payment, resolution, actor } = input
  const sessionId = payment.sessionId
  const note = (input.note ?? "").trim().slice(0, 1000) || null
  const leadId = input.leadId ? String(input.leadId).trim() : null

  let contactId: string | null = null
  let invoiceId: string | null = null
  let creditId: string | null = null
  let invoiceNumber: string | undefined
  let creditNumber: string | null | undefined
  let leadForNote: { id: string; notes: string | null } | null = null

  if (resolution !== "recorded_elsewhere") {
    // The person: the lead staff picked, else the payer. Identity is the EMAIL (never the card holder's name).
    let email = payment.email
    let name = payment.name
    let isTest = false
    if (leadId) {
      const { data: lead, error: leadErr } = await supabaseAdmin.from("leads").select("id, email, full_name, notes, is_test").eq("id", leadId).maybeSingle()
      if (leadErr) return { ok: false, status: 500, error: `Could not read the lead: ${leadErr.message}` }
      if (!lead) return { ok: false, status: 404, error: "Lead not found." }
      const l = lead as { id: string; email: string | null; full_name: string | null; notes: string | null; is_test: boolean | null }
      email = l.email ?? email
      name = l.full_name ?? name
      isTest = !!l.is_test
      leadForNote = { id: l.id, notes: l.notes }
    }
    if (!email) {
      return { ok: false, status: 400, error: "This payment has no email address, so the credit could never be found again. Pick the lead it belongs to." }
    }
    try {
      const r = await recordPaidCall({
        payment: {
          chargeId: `stripe-session:${sessionId}`,
          amount: payment.amount,
          currency: payment.currency,
          provider: "stripe",
          paymentIntentId: payment.paymentIntentId,
        },
        inviteeEmail: email,
        inviteeName: name,
        callDate: payment.paidAt.slice(0, 10),
        isTest,
        manual: { feedId: `stripe-session:${sessionId}`, sourceLabel: "Stripe payment", creditUsedAtCreation: resolution === "paid_call_already_deducted" },
      })
      contactId = r.contactId
      invoiceId = r.invoiceId
      creditId = r.creditId
      invoiceNumber = r.invoiceNumber
      creditNumber = r.creditNumber
    } catch (err) {
      return { ok: false, status: 500, error: `Could not record the paid call: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  const { error: insErr } = await db().from("incoming_payment_resolutions").insert({
    stripe_session_id: sessionId,
    resolution,
    contact_id: contactId,
    lead_id: leadForNote?.id ?? (leadId || null),
    invoice_payment_id: invoiceId,
    credit_payment_id: creditId,
    note,
    resolved_by: actor,
  })
  // 23505 = a colleague (or Stripe's redelivery) settled the same payment a moment ago; the paid-call rows are keyed on the session, so nothing doubled.
  if (insErr && insErr.code !== "23505") {
    return { ok: false, status: 500, error: `The payment was recorded but the confirmation could not be saved (${insErr.message}). Press Confirm again: nothing will be recorded twice.` }
  }

  // CRM update rule: leave a dated line on the lead (only on the first settle: a redelivery must not repeat it).
  if (leadForNote && !insErr) {
    const day = new Date().toISOString().slice(0, 10)
    const what = resolution === "paid_call" ? "confirmed as a paid call (credit kept)" : resolution === "paid_call_already_deducted" ? "confirmed as a paid call (already deducted by hand, no credit left)" : "marked as recorded elsewhere"
    const line = `${day}: ${payment.currency === "EUR" ? "€" : "$"}${payment.amount} Stripe payment ${what} by ${actor}.`
    await supabaseAdmin.from("leads").update({ notes: leadForNote.notes ? `${leadForNote.notes}\n${line}` : line }).eq("id", leadForNote.id)
  }

  return { ok: true, resolution, alreadySettled: false, invoiceNumber, creditNumber, contactId: contactId ?? undefined }
}

export async function confirmIncomingPayment(input: {
  sessionId: string
  resolution: unknown
  leadId?: string | null
  note?: string | null
  actor: string
}): Promise<ConfirmResult> {
  const { sessionId } = input
  if (!SESSION_ID_RE.test(sessionId)) return { ok: false, status: 400, error: "That is not a Stripe payment id." }
  if (!isResolution(input.resolution)) return { ok: false, status: 400, error: "Pick what this payment was." }
  const resolution = input.resolution
  const note = (input.note ?? "").trim().slice(0, 1000) || null
  const leadId = input.leadId ? String(input.leadId).trim() : null
  if (leadId && !UUID_RE.test(leadId)) return { ok: false, status: 400, error: "That lead id is not valid." }
  if (resolution === "recorded_elsewhere" && (note?.length ?? 0) < 3) {
    return { ok: false, status: 400, error: "Write where this payment is recorded (a few words), so the record explains itself." }
  }

  // Already settled? (double click, or a colleague got there first) — a calm answer, never a second record.
  const { data: done, error: doneErr } = await db()
    .from("incoming_payment_resolutions")
    .select("resolution")
    .eq("stripe_session_id", sessionId)
    .maybeSingle()
  if (doneErr) return { ok: false, status: 500, error: `Could not check whether this payment was already confirmed: ${doneErr.message}` }
  if (done) return { ok: true, resolution: (done as { resolution: Resolution }).resolution, alreadySettled: true }

  const payment = await loadWaitingPaymentBySession(sessionId)
  if (!payment) {
    return { ok: false, status: 404, error: "This payment is not waiting for confirmation (it may carry a label, or it is not in the saved Stripe events)." }
  }

  return settlePayment({ payment, resolution, leadId, note, actor: input.actor })
}
