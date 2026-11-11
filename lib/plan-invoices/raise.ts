/**
 * Raise AND SEND one later part of a payment plan — only ever on a person's click (dev job ae3c19db).
 *
 * Antonio, 2026-11-11: "I want nothing automatic". This is the ONE place a later part becomes an invoice, and it runs only from the
 * Calendar's "Invoices to raise" button (route /api/crm/admin-actions/raise-plan-part). The daily job that used to do the same thing
 * by itself for date parts is gone.
 *
 * It is the machinery that job used, moved here unchanged in what it does:
 *   WHO PAYS — the offer's own "Invoice to" (`invoiceTargetForOffer`): the person who signed, or a chosen company / billing entity.
 *     Never the company the offer later got linked to (Antonio: "the one who has to pay is the one who originally signed").
 *   NO DOUBLE BILL — idempotency key `offer-tranche:TOKEN:SEQ` plus the database's one-live-invoice-per-part index: a second click, a
 *     retry, or a second person clicking at the same moment gets the FIRST invoice back, never a second one.
 *   SENT — the Draft is emailed to the client in the same click (a Draft that nobody sends is a part the client was never told about;
 *     the bank matcher ignores a Draft). A part already raised as a Draft is simply sent. EXACTLY ONE EMAIL even when several people click
 *     at the same moment: only the click that wins `claimInvoiceSend` emails (the idempotency key alone made one INVOICE, not one EMAIL).
 *   THE AMOUNT is the plan's (the part's agreed figure + the offer's card-fee rate, as part 1 was billed) — never typed here.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { validatePaymentPlan, trancheInvoiceDescription } from "@/lib/offers/payment-plan"
import { planStatusForOffer, isRaisable, resolveTrancheCardFeeRate } from "@/lib/offers/payment-plan-state"
import { invoiceTargetForOffer } from "@/lib/offers/bill-to-server"
import { chosenInvoiceDescription } from "@/lib/offers/invoice-description"
import { parseBillTo } from "@/lib/offers/bill-to"
import { payerOfPartOne, samePayer, type InvoicePayerRow, type PayerIds } from "@/lib/plan-invoices/payer"
import { createTDInvoice } from "@/lib/portal/td-invoice"
import { sendTDInvoice } from "@/lib/invoice-auto-send"
import { claimInvoiceSend, releaseInvoiceSendClaim } from "@/lib/operations/invoice-send-claim"
import type { Json } from "@/lib/database.types"

export interface RaisePlanPartResult {
  ok: boolean
  /** Plain-English sentence for the toast — what happened, or exactly why not. */
  message: string
  invoiceNumber?: string
  /** True when the client was emailed in this click. */
  sent?: boolean
}

interface OfferForRaise {
  token: string
  client_name: string | null
  status: string | null
  account_id: string | null
  contact_id: string | null
  lead_id: string | null
  bill_to: unknown
  services: unknown
  invoice_description?: string | null
}

export async function raiseAndSendPlanPart(p: { token: string; seq: number; actor: string }): Promise<RaisePlanPartResult> {
  const offerQuery = supabaseAdmin
    .from("offers")
    .select("token, client_name, status, account_id, contact_id, lead_id, bill_to, services, invoice_description" as never)
    .eq("token", p.token)
    .maybeSingle() as unknown as PromiseLike<{ data: OfferForRaise | null; error: { message: string } | null }>
  const { data: offer, error: offerErr } = await offerQuery
  if (offerErr) return { ok: false, message: `The offer could not be read: ${offerErr.message}` }
  if (!offer) return { ok: false, message: "That offer does not exist." }
  // Same rule as the list: a plan is an agreement only once the client signed.
  if (offer.status !== "signed" && offer.status !== "completed") return { ok: false, message: "That offer is not signed yet, so nothing can be invoiced from it." }

  const status = await planStatusForOffer(p.token)
  if (!status) return { ok: false, message: "That offer has no valid payment plan." }
  const partStatus = status.parts.find((s) => s.part.seq === p.seq)
  if (!partStatus) return { ok: false, message: `The plan has no part ${p.seq}.` }
  const part = partStatus.part
  if (part.trigger.kind === "signing") return { ok: false, message: "Part 1 is invoiced when the client signs — it is not raised from here." }
  if (validatePaymentPlan(status.plan).ok !== true) return { ok: false, message: "That payment plan no longer adds up, so it cannot be invoiced." }

  // Already sent / paid: say so plainly and change nothing. (A Draft is allowed through: it only needs sending.)
  if (!isRaisable(partStatus) && partStatus.state !== "raised_unsent") {
    return { ok: false, message: `Part ${p.seq} already has invoice ${partStatus.invoice?.invoice_number ?? ""} (${partStatus.state.replace(/_/g, " ")}) — nothing more to raise.` }
  }

  // "Invoice to": the offer's chosen payer. A lead's offer only learns its person when the client signs.
  let personId = offer.contact_id
  if (!personId && offer.lead_id) {
    const { data: lead, error: leadErr } = await supabaseAdmin.from("leads").select("converted_to_contact_id").eq("id", offer.lead_id).maybeSingle()
    if (leadErr) return { ok: false, message: `The client could not be looked up (${leadErr.message}) — nothing was invoiced. Please try again.` }
    personId = lead?.converted_to_contact_id ?? null
  }
  let target: { account_id: string | null; contact_id: string | null; billing_entity_id: string | null }
  if (parseBillTo(offer.bill_to ?? null).billTo === null) {
    // No "Invoice to" was ever set on this offer: follow where PART 1 went (the signer), not the company the offer was linked to
    // afterwards — production had part 1 on the person and part 2 on the company for exactly such an offer (see payer.ts).
    const { data: oneRows, error: oneErr } = await (supabaseAdmin
      .from("payments")
      .select("tranche_seq, invoice_status, account_id, contact_id, billing_entity_id" as never)
      .eq("tranche_offer_token" as never, p.token as never)
      .eq("tranche_seq" as never, 1 as never) as unknown as PromiseLike<{ data: InvoicePayerRow[] | null; error: { message: string } | null }>)
    if (oneErr) return { ok: false, message: `Part 1 of the plan could not be read (${oneErr.message}) — nothing was invoiced. Please try again.` }
    const one = payerOfPartOne(oneRows ?? [])
    target = one ? { ...one, contact_id: one.contact_id ?? personId ?? null } : await invoiceTargetForOffer({ billTo: null, offerAccountId: offer.account_id, contactId: personId })
  } else {
    target = await invoiceTargetForOffer({ billTo: offer.bill_to ?? null, offerAccountId: offer.account_id, contactId: personId })
  }
  if (!target.account_id && !target.contact_id) return { ok: false, message: "The offer has no person or company to invoice." }

  const serviceLabel =
    chosenInvoiceDescription(offer) ||
    (Array.isArray(offer.services) && (offer.services[0] as { name?: string } | undefined)?.name) ||
    "Setup Fee"
  const description = trancheInvoiceDescription(part, status.plan.length, serviceLabel)
  const cardFeeRate = await resolveTrancheCardFeeRate(p.token)

  let invoice: Awaited<ReturnType<typeof createTDInvoice>>
  try {
    invoice = await createTDInvoice({
      account_id: target.account_id ?? undefined,
      contact_id: target.contact_id ?? undefined,
      billing_entity_id: target.billing_entity_id,
      // Same as part 1 at signing: the PERSON's credit pool is the one netted, even when the invoice is addressed to a company.
      credit_scope: "contact",
      line_items: [{ description, unit_price: part.amount, quantity: 1 }],
      currency: part.currency === "EUR" ? "EUR" : "USD",
      ...(part.trigger.kind === "date" && part.trigger.date ? { due_date: part.trigger.date } : {}),
      idempotency_key: `offer-tranche:${p.token}:${part.seq}`,
      tranche_offer_token: p.token,
      tranche_seq: part.seq,
      payment_category: "setup_tranche",
      ...(cardFeeRate !== undefined ? { card_fee_rate: cardFeeRate } : {}),
    })
  } catch (err) {
    return { ok: false, message: `The invoice could not be raised: ${err instanceof Error ? err.message : String(err)}` }
  }

  let sent = false
  // A Draft for this part may already exist from somewhere else (the company page's own Raise button uses the same key) and be
  // addressed to a DIFFERENT payer than this offer's "Invoice to". The key hands it back unchanged; emailing it would send the wrong
  // party an invoice while this screen says "bill to the signer". Refuse, say why, send nothing.
  if (invoice.status === "Draft") {
    const { data: made } = await (supabaseAdmin
      .from("payments")
      .select("account_id, contact_id, billing_entity_id")
      .eq("id", invoice.paymentId)
      .maybeSingle() as unknown as PromiseLike<{ data: PayerIds | null }>)
    if (made && !samePayer(made, target)) {
      return {
        ok: false,
        invoiceNumber: invoice.invoiceNumber,
        message: `Invoice ${invoice.invoiceNumber} already exists as a draft, but it is addressed to a different payer than this offer's "Invoice to". Nothing was sent. Open it from the client's page, void it, then raise it again from here.`,
      }
    }
  }
  // Only a genuinely unsent Draft is emailed — the idempotency key can hand back an already Sent or Paid row (someone else clicked first).
  if (invoice.status === "Draft") {
    // EXACTLY ONE EMAIL: several clicks at once all get the SAME Draft back from the key, and sendTDInvoice checks "already sent?" before
    // it sends, so they would all pass that check and each email the client (found by the end-to-end run: five clicks, five emails).
    // Only the click that wins this atomic claim sends; the others report "someone else is sending it".
    let won: boolean
    try {
      won = await claimInvoiceSend(invoice.paymentId)
    } catch (err) {
      return { ok: false, invoiceNumber: invoice.invoiceNumber, message: `Invoice ${invoice.invoiceNumber} was created but not sent (${err instanceof Error ? err.message : String(err)}). Reload and use "Send invoice".` }
    }
    if (won) {
      try {
        await sendTDInvoice(invoice.paymentId)
        sent = true
      } catch (err) {
        await releaseInvoiceSendClaim(invoice.paymentId)
        return { ok: false, invoiceNumber: invoice.invoiceNumber, message: `Invoice ${invoice.invoiceNumber} was created but could not be emailed: ${err instanceof Error ? err.message : String(err)}. It stays in the list as a draft — use "Send invoice" to try again.` }
      }
    } else {
      return { ok: true, sent: false, invoiceNumber: invoice.invoiceNumber, message: `Invoice ${invoice.invoiceNumber} is already being sent by someone else — nothing more was sent.` }
    }
  }
  // The audit row is a record, not a gate: the invoice already exists (and was sent), so a failed log write must not turn that into an error.
  const { error: logErr } = await supabaseAdmin.from("action_log").insert({
    action_type: "plan_part_raised_from_calendar",
    table_name: "payments",
    record_id: invoice.paymentId,
    account_id: target.account_id,
    contact_id: target.contact_id,
    summary: `Payment-plan part ${part.seq} of ${status.plan.length} of offer ${p.token} raised${sent ? " and sent" : ""} from the Calendar by ${p.actor}: ${invoice.invoiceNumber}`,
    details: { offer_token: p.token, seq: part.seq, invoice_number: invoice.invoiceNumber, amount: part.amount, currency: part.currency, sent, actor: p.actor, status_before: invoice.status } as unknown as Json,
  })
  if (logErr) console.error("[plan-invoices] audit row could not be written:", logErr.message)
  return {
    ok: true,
    sent,
    invoiceNumber: invoice.invoiceNumber,
    message: sent ? `Invoice ${invoice.invoiceNumber} raised and sent.` : `Invoice ${invoice.invoiceNumber} already exists (${invoice.status.toLowerCase()}) — nothing more was sent.`,
  }
}
