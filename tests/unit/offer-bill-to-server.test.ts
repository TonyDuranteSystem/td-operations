import { describe, it, expect, vi, beforeEach } from "vitest"

let existing: Array<{ id: string; entity_name: string; billing_address?: string | null; country?: string | null; vat_number?: string | null; fiscal_code?: string | null }> = []
const inserts: Array<Record<string, unknown>> = []
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: async () => ({ data: existing, error: null }) }),
      insert: (row: Record<string, unknown>) => {
        inserts.push(row)
        return { select: () => ({ single: async () => ({ data: { id: "be-new" }, error: null }) }) }
      },
    }),
  },
}))

import { ensureBillingEntity, invoiceTargetForOffer } from "@/lib/offers/bill-to-server"

const ACC = "1e23b37f-6a09-4ebf-bcf6-328176121c50"

beforeEach(() => { existing = []; inserts.length = 0 })

describe("ensureBillingEntity", () => {
  it("reuses the contact's entity with the same name (case/space-insensitive)", async () => {
    existing = [{ id: "be-1", entity_name: "Rossi Srl" }]
    expect(await ensureBillingEntity("c1", { name: " rossi srl " })).toBe("be-1")
    expect(inserts).toHaveLength(0)
  })
  it("same name but NEW address/VAT → a new entity (the invoice prints what staff typed; old invoices keep theirs)", async () => {
    existing = [{ id: "be-1", entity_name: "Rossi Srl", billing_address: "Via Vecchia 1", vat_number: "IT111" }]
    expect(await ensureBillingEntity("c1", { name: "Rossi Srl", address: "Via Nuova 2", vat_number: "IT222" })).toBe("be-new")
    expect(inserts[0]).toMatchObject({ billing_address: "Via Nuova 2", vat_number: "IT222" })
  })
  it("same details retyped (spacing/case) → reuses the entity", async () => {
    existing = [{ id: "be-1", entity_name: "Rossi Srl", billing_address: "Via Roma 1, Milano", country: "Italy", vat_number: "IT111" }]
    expect(await ensureBillingEntity("c1", { name: "ROSSI SRL", address: "via roma 1,  Milano", country: " italy", vat_number: "it111" })).toBe("be-1")
    expect(inserts).toHaveLength(0)
  })
  it("creates it otherwise, with the typed details", async () => {
    expect(await ensureBillingEntity("c1", { name: "Rossi Srl", vat_number: "IT123" })).toBe("be-new")
    expect(inserts[0]).toMatchObject({ contact_id: "c1", entity_name: "Rossi Srl", vat_number: "IT123" })
  })
})

describe("invoiceTargetForOffer", () => {
  it("company-page offer, no choice → the company", async () => {
    expect(await invoiceTargetForOffer({ billTo: null, offerAccountId: ACC, contactId: "c1" })).toEqual({ account_id: ACC, contact_id: "c1", billing_entity_id: null })
  })
  it("lead/contact offer, no choice → the person, never a guessed company", async () => {
    expect(await invoiceTargetForOffer({ billTo: null, offerAccountId: null, contactId: "c1" })).toEqual({ account_id: null, contact_id: "c1", billing_entity_id: null })
  })
  it("a lead paying with his own company (typed) → saved as his billing entity and used", async () => {
    const t = await invoiceTargetForOffer({ billTo: { type: "entity", entity: { name: "Rossi Srl" } }, offerAccountId: null, contactId: "c1" })
    expect(t).toEqual({ account_id: null, contact_id: "c1", billing_entity_id: "be-new" })
  })
  it("typed payer but no contact yet → person-only target, nothing saved", async () => {
    const t = await invoiceTargetForOffer({ billTo: { type: "entity", entity: { name: "Rossi Srl" } }, offerAccountId: null, contactId: null })
    expect(t.billing_entity_id).toBeNull()
    expect(inserts).toHaveLength(0)
  })
})
