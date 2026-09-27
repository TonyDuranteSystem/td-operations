/**
 * "Invoice to" on an offer (workspace-only plan S1, dev job 9d34e750,
 * Antonio 2026-09-27).
 *
 * The offer lives where it was created — a lead page, a contact page or a
 * company page. By default the invoice goes to that same place (a company-page
 * offer → the company; a lead/contact offer → the person). Staff can pick a
 * different payer on the offer, e.g. a lead who pays with his own company that
 * is not in the CRM yet ("entity", saved as one of the contact's billing
 * entities at signing).
 *
 * Replaces the old guess ("the client's FIRST linked company") used when the
 * offer had no company. Pure — no DB access — so every case is unit-testable.
 */

export interface BillToEntityDetails {
  name: string
  address?: string | null
  country?: string | null
  vat_number?: string | null
  fiscal_code?: string | null
}

export type BillTo =
  | { type: "person" }
  | { type: "company"; account_id: string }
  | { type: "entity"; billing_entity_id: string }
  | { type: "entity"; entity: BillToEntityDetails }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const clean = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

/**
 * Validate a raw bill_to value. Returns `{ billTo }` (null = not set, legacy
 * default) or `{ error }` with a plain message for staff.
 */
export function parseBillTo(raw: unknown): { billTo: BillTo | null; error?: undefined } | { billTo?: undefined; error: string } {
  if (raw === null || raw === undefined) return { billTo: null }
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: "Invoice to: invalid value" }
  const r = raw as Record<string, unknown>
  if (r.type === "person") return { billTo: { type: "person" } }
  if (r.type === "company") {
    if (typeof r.account_id !== "string" || !UUID.test(r.account_id)) return { error: "Invoice to: pick the company" }
    return { billTo: { type: "company", account_id: r.account_id } }
  }
  if (r.type === "entity") {
    if (typeof r.billing_entity_id === "string") {
      if (!UUID.test(r.billing_entity_id)) return { error: "Invoice to: invalid billing entity" }
      return { billTo: { type: "entity", billing_entity_id: r.billing_entity_id } }
    }
    const e = (r.entity && typeof r.entity === "object" ? r.entity : {}) as Record<string, unknown>
    const name = clean(e.name)
    if (!name) return { error: "Invoice to: enter the company name" }
    return {
      billTo: {
        type: "entity",
        entity: { name, address: clean(e.address), country: clean(e.country), vat_number: clean(e.vat_number), fiscal_code: clean(e.fiscal_code) },
      },
    }
  }
  return { error: "Invoice to: invalid choice" }
}

export interface InvoiceTarget {
  /** The company the invoice sits on, or null = it sits on the person. */
  account_id: string | null
  contact_id: string | null
  /** An existing billing entity to print on the invoice. */
  billing_entity_id: string | null
  /** A typed payer to save as a billing entity of the contact, then print. */
  new_entity: BillToEntityDetails | null
}

/**
 * Where the invoice for this offer goes. Never guesses a company: a lead or
 * contact offer with no explicit choice is invoiced to the person.
 */
export function resolveInvoiceTarget(p: {
  billTo: unknown
  offerAccountId: string | null | undefined
  contactId: string | null | undefined
}): InvoiceTarget {
  const contact_id = p.contactId ?? null
  const parsed = parseBillTo(p.billTo)
  const billTo = parsed.billTo ?? null
  const base = { contact_id, billing_entity_id: null, new_entity: null }
  if (!billTo) return { ...base, account_id: p.offerAccountId ?? null }
  if (billTo.type === "person") return { ...base, account_id: null }
  if (billTo.type === "company") return { ...base, account_id: billTo.account_id }
  if ("billing_entity_id" in billTo) return { ...base, account_id: null, billing_entity_id: billTo.billing_entity_id }
  return { ...base, account_id: null, new_entity: billTo.entity }
}
