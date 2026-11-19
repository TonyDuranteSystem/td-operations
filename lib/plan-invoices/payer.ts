/**
 * Who a later part of a payment plan is billed to — the two rules the end-to-end QA run (dev job ae3c19db) showed were missing.
 * PURE: no database. Used by the Calendar list (load.ts) and the one raise path (raise.ts) so both name the same payer.
 *
 * 1. An offer whose "Invoice to" was NEVER SET (older offers, offers made through the assistant tools) used to follow the offer's
 *    company link at part 2 — but part 1 had been billed to the PERSON, because the company did not exist yet when the client signed.
 *    Production had exactly this: part 1 on the person, part 2 on the company. Antonio: "the one who has to pay is the one who
 *    originally signed the contract". So when "Invoice to" is empty, part 2 and later follow where part 1 actually went.
 * 2. A part can already hold a Draft made somewhere else (the company page's own Raise button uses the same key). Such a Draft
 *    may be addressed to a different payer than this offer's "Invoice to"; sending it would email the wrong party while the Calendar
 *    says "bill to the signer". `samePayer` is the check that stops that.
 */

import { DEAD_INVOICE_STATUSES } from "@/lib/offers/payment-plan-state"

export interface PayerIds {
  account_id: string | null
  contact_id: string | null
  billing_entity_id: string | null
}

export interface InvoicePayerRow extends PayerIds {
  tranche_seq: number | null
  invoice_status: string | null
}

const isDead = (status: string | null): boolean => (DEAD_INVOICE_STATUSES as readonly string[]).includes(status ?? "")

/** Where part 1 actually went: the live part-1 invoice if there is one, else any part-1 invoice. Null = part 1 has no invoice (yet). */
export function payerOfPartOne(rows: InvoicePayerRow[]): PayerIds | null {
  const ones = rows.filter((r) => Number(r.tranche_seq) === 1 && (r.account_id || r.contact_id || r.billing_entity_id))
  const pick = ones.find((r) => !isDead(r.invoice_status)) ?? ones[0]
  if (!pick) return null
  return { account_id: pick.account_id ?? null, contact_id: pick.contact_id ?? null, billing_entity_id: pick.billing_entity_id ?? null }
}

/**
 * Is this invoice addressed to the payer the offer's "Invoice to" names? The company and the billing entity must match exactly; the
 * person is compared only when the target is a person or an entity (an invoice on a company also carries the signer as a contact,
 * which is not the payer there).
 */
export function samePayer(invoice: PayerIds, target: PayerIds): boolean {
  const eq = (a: string | null | undefined, b: string | null | undefined) => (a ?? null) === (b ?? null)
  if (!eq(invoice.account_id, target.account_id)) return false
  if (!eq(invoice.billing_entity_id, target.billing_entity_id)) return false
  return target.account_id ? true : eq(invoice.contact_id, target.contact_id)
}
