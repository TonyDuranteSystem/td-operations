import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseAllowedValues } from "@/lib/db-contract"

/**
 * A typed "Invoice to" company (not in the CRM) is saved as a billing entity when the offer is signed.
 * PRODUCTION once refused that save: the code wrote the label "company" into entity_type, and production's
 * CHECK only allowed SRL / SRLS / SPA / ditta_individuale / persona_fisica / GmbH / Ltd / other. The sandbox has
 * no such CHECK, so every sandbox run passed. Dev job 709ac868.
 *
 * This test replays the save against PRODUCTION'S OWN committed rule (db/constraints.prod.json), so the sandbox's
 * missing constraint can never hide it again. Nothing reads a payer's type, so the save must not write one.
 */

const snapshot = JSON.parse(readFileSync(join(process.cwd(), "db", "constraints.prod.json"), "utf8")) as {
  constraints: Record<string, string>
}
const productionRule = snapshot.constraints["billing_entities_entity_type_check"] // gone once production drops it
const allowedByProduction = productionRule ? parseAllowedValues(productionRule) : null

const inserts: Array<Record<string, unknown>> = []
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: async () => ({ data: [], error: null }) }),
      insert: (row: Record<string, unknown>) => {
        inserts.push(row)
        // The real database: a CHECK passes on NULL / not-written, and rejects any other value outside its list.
        const type = row.entity_type
        const rejected = allowedByProduction !== null && type !== undefined && type !== null && !allowedByProduction.includes(String(type))
        return {
          select: () => ({
            single: async () =>
              rejected
                ? { data: null, error: { message: 'new row for relation "billing_entities" violates check constraint "billing_entities_entity_type_check"' } }
                : { data: { id: "be-new" }, error: null },
          }),
        }
      },
    }),
  },
}))

import { ensureBillingEntity, invoiceTargetForOffer } from "@/lib/offers/bill-to-server"

beforeEach(() => { inserts.length = 0 })

describe("typed payer is saved the way production accepts it", () => {
  it("the committed production rule still lists the types the database allows (guard: the test is not vacuous)", () => {
    if (allowedByProduction === null) return // production dropped the rule: nothing left to violate
    expect(allowedByProduction).toContain("Ltd")
    expect(allowedByProduction).not.toContain("company")
  })

  it("saves a typed payer without being refused by production's rule", async () => {
    const id = await ensureBillingEntity("c1", {
      name: "Good Company LTD",
      address: "Fortov Pat 15, 1336 Sofia",
      country: "Bulgaria",
      vat_number: "BG206881490",
    })
    expect(id).toBe("be-new")
  })

  it("writes no type at all (a type is a label nothing reads)", async () => {
    await ensureBillingEntity("c1", { name: "PLMG LTD", country: "Bulgaria" })
    expect(inserts).toHaveLength(1)
    expect(inserts[0].entity_type ?? null).toBeNull()
    expect(inserts[0]).toMatchObject({ contact_id: "c1", entity_name: "PLMG LTD", country: "Bulgaria" })
  })

  it("an offer whose Invoice to is a typed company resolves to a saved payer (signing keeps its invoice)", async () => {
    const t = await invoiceTargetForOffer({
      billTo: { type: "entity", entity: { name: "PLMG LTD", address: "25 Vitosha blvd,. fl. 2", country: "Bulgaria", vat_number: "BG206700239" } },
      offerAccountId: null,
      contactId: "c1",
    })
    expect(t).toEqual({ account_id: null, contact_id: "c1", billing_entity_id: "be-new" })
  })
})
