/**
 * Paid strategy call → revenue + a deductible credit (WS-A, dev job c0a61e44).
 *
 * A paid Calendly booking produces TWO rows, both keyed on the Stripe charge so
 * a webhook re-delivery is a no-op:
 *   1. a PAID invoice — the call is real revenue, and its Stripe payment-intent
 *      id is stamped so the existing bank-feed tier links the payout row when it
 *      lands (the ids are equal in identity but not in format: Calendly gives a
 *      charge id, the matcher compares payment-intent ids).
 *   2. a CREDIT NOTE for the same amount, scoped to the PERSON — this is what
 *      makes the fee deductible from whatever service they buy next, via the
 *      netting engine (no offer field holds money).
 *
 * Identity comes from the INVITEE's email, never the payer's name: the Aug-5
 * booking was paid on a card belonging to someone else entirely.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { createTDInvoice } from "@/lib/portal/td-invoice"
import { paidCallIdempotencyKey, paidCallDescription, type CalendlyPayment } from "@/lib/calendly/paid-booking"
import { paymentIntentIdForCharge } from "@/lib/stripe-sync"

export interface PaidCallResult {
  contactId: string
  contactCreated: boolean
  invoiceId: string
  invoiceNumber: string
  creditId: string | null
  creditNumber: string | null
  paymentIntentStamped: boolean
  accountId: string | null
}

/**
 * Resolve the booker to a contact, creating one when unknown (Antonio-approved:
 * the credit is a payments row and payments require a contact or an account, so
 * without this the fee simply cannot be recorded).
 */
async function resolveContact(email: string, name: string | null): Promise<{ id: string; created: boolean }> {
  const { data: existing } = await supabaseAdmin
    .from("contacts")
    .select("id")
    .ilike("email", email)
    .limit(1)
    .maybeSingle()
  if (existing) return { id: (existing as { id: string }).id, created: false }

  // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw contacts.insert; same sanctioned path as offer-signed's lead→contact conversion (dev_task 98484283)
  const { data: created, error } = await supabaseAdmin
    .from("contacts")
    .insert({ full_name: name || email.split("@")[0], email, status: "active" })
    .select("id")
    .single()
  if (error || !created) throw new Error(`paid-call: contact creation failed for ${email}: ${error?.message}`)
  return { id: (created as { id: string }).id, created: true }
}

/** The contact's sole account, when they have exactly one (never guess between two). */
async function soleAccountFor(contactId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("account_contacts")
    .select("account_id")
    .eq("contact_id", contactId)
    .limit(2)
  const rows = (data ?? []) as Array<{ account_id: string }>
  return rows.length === 1 ? rows[0].account_id : null
}

export async function recordPaidCall(params: {
  payment: CalendlyPayment
  inviteeEmail: string
  inviteeName?: string | null
  callDate?: string | null
}): Promise<PaidCallResult> {
  const { payment, inviteeEmail, inviteeName, callDate } = params
  const description = paidCallDescription(callDate ?? null)

  const contact = await resolveContact(inviteeEmail, inviteeName ?? null)
  // An EXISTING client's credit is stamped with their company at creation, so it
  // is visible to account-scoped invoices immediately (a later backfill would
  // not reach an already-created credit).
  const accountId = await soleAccountFor(contact.id)

  // 1. The revenue row — Paid, because the money is already collected.
  const invoice = await createTDInvoice({
    contact_id: contact.id,
    ...(accountId ? { account_id: accountId } : {}),
    line_items: [{ description, unit_price: payment.amount, quantity: 1 }],
    currency: payment.currency,
    mark_as_paid: true,
    payment_method: "Stripe",
    notes: `Paid strategy call (Calendly booking, charge ${payment.chargeId}).`,
    idempotency_key: paidCallIdempotencyKey(payment.chargeId, "invoice"),
    // A paid row must never absorb credits — it is revenue, not a bill.
    skip_credit_netting: true,
  })

  // 2. Stamp the payment-intent id so the bank-feed matcher's certain-link tier
  //    can tie the payout row to this invoice when it arrives (days later).
  let paymentIntentStamped = false
  const pi = await paymentIntentIdForCharge(payment.chargeId)
  if (pi) {
    // eslint-disable-next-line no-restricted-syntax -- matcher-link bookkeeping on the invoice row we just created; not a client/tier field.
    const { error } = await supabaseAdmin
      .from("payments")
      .update({ stripe_payment_id: pi })
      .eq("id", invoice.paymentId)
    if (error) console.error(`[paid-call] payment-intent stamp failed for ${invoice.invoiceNumber}:`, error.message)
    else paymentIntentStamped = true
  } else {
    console.warn(`[paid-call] no payment intent resolved for charge ${payment.chargeId} — feed link will need a manual match.`)
  }

  // 3. The credit note — what makes the fee deductible. Negative line ⇒ the
  //    invoice helper mints a CN- number and this row becomes available credit.
  const credit = await createTDInvoice({
    contact_id: contact.id,
    ...(accountId ? { account_id: accountId } : {}),
    line_items: [{ description: `Credit — ${description}`, unit_price: -payment.amount, quantity: 1 }],
    currency: payment.currency,
    notes: `Deductible from the client's next service purchase (paid call, charge ${payment.chargeId}).`,
    idempotency_key: paidCallIdempotencyKey(payment.chargeId, "credit"),
    skip_credit_netting: true,
  })

  // Mark it as live credit: available balance + Credit status.
  // eslint-disable-next-line no-restricted-syntax -- credit-note bookkeeping on the row just created (same sanctioned class as issueReferralCreditNote).
  const { error: creditErr } = await supabaseAdmin
    .from("payments")
    .update({ invoice_status: "Credit", credit_remaining: payment.amount })
    .eq("id", credit.paymentId)
  if (creditErr) throw new Error(`paid-call: credit note activation failed: ${creditErr.message}`)

  return {
    contactId: contact.id,
    contactCreated: contact.created,
    invoiceId: invoice.paymentId,
    invoiceNumber: invoice.invoiceNumber,
    creditId: credit.paymentId,
    creditNumber: credit.invoiceNumber,
    paymentIntentStamped,
    accountId,
  }
}
