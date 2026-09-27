/**
 * Server side of "Invoice to" (S1, 2026-09-27): turn an offer's choice into
 * the concrete invoice target — the company, the person, or one of the
 * person's billing entities (a typed payer is saved as a billing entity the
 * first time, then reused). See lib/offers/bill-to.ts for the rule.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { resolveInvoiceTarget, type BillToEntityDetails } from "@/lib/offers/bill-to"

export interface ResolvedInvoiceTarget {
  account_id: string | null
  contact_id: string | null
  billing_entity_id: string | null
}

/** The offer's stored "Invoice to" (null when not set / not found). */
export async function offerBillTo(offerToken: string | null | undefined): Promise<unknown> {
  if (!offerToken) return null
  // bill_to is newer than the generated DB types — read it on its own.
  const { data } = await supabaseAdmin
    .from("offers")
    .select("bill_to" as never)
    .eq("token", offerToken)
    .maybeSingle()
  return (data as { bill_to?: unknown } | null)?.bill_to ?? null
}

/** Find the contact's billing entity with this name (case-insensitive), else create it. */
export async function ensureBillingEntity(contactId: string, e: BillToEntityDetails): Promise<string> {
  const { data: existing, error: findErr } = await supabaseAdmin
    .from("billing_entities")
    .select("id, entity_name")
    .eq("contact_id", contactId)
  if (findErr) throw new Error(`billing entity lookup failed: ${findErr.message}`)
  const match = (existing ?? []).find((r) => (r.entity_name ?? "").trim().toLowerCase() === e.name.trim().toLowerCase())
  if (match) return match.id
  const { data: created, error: insErr } = await supabaseAdmin
    .from("billing_entities")
    .insert({
      contact_id: contactId,
      entity_name: e.name,
      billing_address: e.address ?? null,
      country: e.country ?? null,
      vat_number: e.vat_number ?? null,
      fiscal_code: e.fiscal_code ?? null,
      entity_type: "company",
    })
    .select("id")
    .single()
  if (insErr || !created) throw new Error(`billing entity create failed: ${insErr?.message ?? "no row"}`)
  return created.id
}

/**
 * The invoice target for an offer. Never guesses a company. A typed payer
 * needs a contact to hang on; with none yet it falls back to the person-only
 * target and the caller can still bill.
 */
export async function invoiceTargetForOffer(p: {
  billTo: unknown
  offerAccountId: string | null | undefined
  contactId: string | null | undefined
}): Promise<ResolvedInvoiceTarget> {
  const t = resolveInvoiceTarget(p)
  let billing_entity_id = t.billing_entity_id
  if (!billing_entity_id && t.new_entity && t.contact_id) {
    billing_entity_id = await ensureBillingEntity(t.contact_id, t.new_entity)
  }
  return { account_id: t.account_id, contact_id: t.contact_id, billing_entity_id }
}
