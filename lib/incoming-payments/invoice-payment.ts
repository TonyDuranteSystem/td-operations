/**
 * A waiting payment that paid an EXISTING open invoice (incoming-payments Phase 3, dev job 40a58d9a). SERVER-ONLY.
 *
 * Uses the same settle engine as a wire or a labelled Stripe payment (`reconcilePaymentByInvoiceNumber` → `confirmPayment` →
 * `applyMoneyToInvoice`): the invoice is marked paid with the amount actually charged, the installment handler runs, and the
 * Stripe id is stamped on it. This file only decides WHETHER it is safe to apply the money:
 *   - the invoice must be open (Pending / Overdue, not Draft / Paid / Cancelled / Voided / Credit) and carry an invoice number;
 *   - the payer must be tied to it: the invoice belongs to a contact with the payer's email, or to a company of such a contact;
 *   - the currency must match (EUR money never settles a USD invoice);
 *   - the amount must not exceed what is still owed (an overpayment, a card fee on top, needs a human: nothing is applied).
 * A smaller amount is applied as a PART payment (the engine keeps the rest open).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { reconcilePaymentByInvoiceNumber } from "@/lib/operations/payment"
import { emitPaymentReceivedEvent } from "@/lib/portal/chat-events"
import { DEAD_INVOICE_STATUSES } from "@/lib/offers/payment-plan-state"
import type { WaitingPayment, OpenInvoice } from "@/lib/incoming-payments/classify"

export interface InvoicePaymentResult {
  ok: boolean
  status?: number
  error?: string
  invoiceNumber?: string
  paymentId?: string
  partial?: boolean
}

const OPEN_STATUSES = ["Pending", "Overdue"] as const
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The payer's open invoices, for the picker: invoices of any contact with the payer's email, and of those contacts' companies. */
export async function loadOpenInvoicesForPayer(email: string | null): Promise<OpenInvoice[]> {
  if (!email) return []
  const exact = email.replace(/[\\%_]/g, (c) => `\\${c}`)
  const { data: contacts, error: cErr } = await supabaseAdmin.from("contacts").select("id").ilike("email", exact).limit(10)
  if (cErr) throw new Error(`incoming-payments: could not look up the payer's contacts: ${cErr.message}`)
  const contactIds = ((contacts ?? []) as Array<{ id: string }>).map((c) => c.id)
  if (contactIds.length === 0) return []
  const { data: links, error: lErr } = await supabaseAdmin.from("account_contacts").select("account_id").in("contact_id", contactIds)
  if (lErr) throw new Error(`incoming-payments: could not look up the payer's companies: ${lErr.message}`)
  const accountIds = Array.from(new Set(((links ?? []) as Array<{ account_id: string }>).map((l) => l.account_id)))
  const cols = "id, invoice_number, description, amount_due, total, amount_currency, due_date, status, invoice_status"
  const ors = [`contact_id.in.(${contactIds.join(",")})`, ...(accountIds.length ? [`account_id.in.(${accountIds.join(",")})`] : [])].join(",")
  const { data: rows, error } = await supabaseAdmin.from("payments").select(cols).or(ors).in("status", OPEN_STATUSES).not("invoice_number", "is", null).limit(100)
  if (error) throw new Error(`incoming-payments: could not read the payer's open invoices: ${error.message}`)
  return ((rows ?? []) as Array<Record<string, unknown>>)
    .filter((r) => !(DEAD_INVOICE_STATUSES as readonly string[]).includes(String(r.invoice_status ?? "")) && r.invoice_status !== "Draft")
    .map((r) => ({
      paymentId: String(r.id),
      invoiceNumber: String(r.invoice_number),
      description: String(r.description ?? ""),
      amountDue: Number(r.amount_due ?? r.total ?? 0),
      currency: (String(r.amount_currency ?? "USD").toUpperCase() === "EUR" ? "EUR" : "USD") as "EUR" | "USD",
      dueDate: (r.due_date as string | null) ?? null,
      status: String(r.status),
    }))
    .sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber))
}

export async function payInvoiceFromPayment(input: { payment: WaitingPayment; invoicePaymentId: string; actor: string }): Promise<InvoicePaymentResult> {
  const { payment, actor } = input
  if (!UUID_RE.test(input.invoicePaymentId)) return { ok: false, status: 400, error: "Pick the invoice this payment paid." }
  // Only an invoice that is on this payer's own list can be settled: the list is re-built here, never trusted from the browser.
  const open = await loadOpenInvoicesForPayer(payment.email)
  const inv = open.find((i) => i.paymentId === input.invoicePaymentId)
  if (!inv) return { ok: false, status: 400, error: "That invoice is not one of this payer's open invoices (it may already be paid, or belong to someone else)." }
  if (inv.currency !== payment.currency) return { ok: false, status: 400, error: `This payment is in ${payment.currency} but the invoice is in ${inv.currency}. Nothing was applied: settle it by hand.` }
  if (payment.amount > inv.amountDue + 0.005) {
    return { ok: false, status: 400, error: `This payment (${payment.amount}) is more than the invoice still owes (${inv.amountDue}). Nothing was applied: an overpayment or a card fee needs a person to decide.` }
  }

  const r = await reconcilePaymentByInvoiceNumber(inv.invoiceNumber, {
    amountPaid: payment.amount,
    paidDate: payment.paidAt.slice(0, 10),
    stripePaymentId: payment.paymentIntentId || payment.sessionId,
  })
  if (!r.reconciled) {
    return { ok: false, status: 500, error: `The invoice was not settled (${r.outcome ?? "no outcome"}). Nothing was recorded as paid; check the invoice.` }
  }
  if (r.payment_id) {
    try {
      await emitPaymentReceivedEvent({ payment_id: r.payment_id, method_hint: "Stripe" })
    } catch (err) {
      // The money is applied; a missing notification must not turn that into a failure.
      console.error(`[incoming-payments] paid ${inv.invoiceNumber} but the What's New note failed (${actor}):`, err instanceof Error ? err.message : err)
    }
  }
  return { ok: true, invoiceNumber: inv.invoiceNumber, paymentId: r.payment_id, partial: r.outcome === "partial" }
}
