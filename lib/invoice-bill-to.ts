/**
 * Invoice "Bill To" from a billing entity (S1, 2026-09-27). When staff chose
 * "Invoice to: <a payer>" on the offer (e.g. a lead paying with his own
 * company that is not in the CRM), the invoice carries a billing entity and
 * must print THAT name, address and VAT — not the person's or a company's.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

export interface EntityBillTo {
  name: string
  address: string | null
  vatNumber: string | null
}

/** Pure: shape a billing-entity row into the invoice's Bill To fields. */
export function entityRowToBillTo(row: {
  entity_name?: string | null
  billing_address?: string | null
  country?: string | null
  vat_number?: string | null
  fiscal_code?: string | null
} | null | undefined): EntityBillTo | null {
  const name = row?.entity_name?.trim()
  if (!name) return null
  const address = [row?.billing_address?.trim(), row?.country?.trim()].filter(Boolean).join(", ") || null
  const vatNumber = row?.vat_number?.trim() || row?.fiscal_code?.trim() || null
  return { name, address, vatNumber }
}

/** The Bill To for an invoice's billing entity, or null when it has none. */
export async function billingEntityBillTo(billingEntityId: string | null | undefined): Promise<EntityBillTo | null> {
  if (!billingEntityId) return null
  const { data } = await supabaseAdmin
    .from("billing_entities")
    .select("entity_name, billing_address, country, vat_number, fiscal_code")
    .eq("id", billingEntityId)
    .maybeSingle()
  return entityRowToBillTo(data)
}
