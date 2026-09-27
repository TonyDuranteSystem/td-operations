import { describe, it, expect } from "vitest"
import { parseBillTo, resolveInvoiceTarget } from "@/lib/offers/bill-to"

const ACC = "1e23b37f-6a09-4ebf-bcf6-328176121c50"
const ACC2 = "2e23b37f-6a09-4ebf-bcf6-328176121c50"
const BE = "3e23b37f-6a09-4ebf-bcf6-328176121c50"

describe("parseBillTo", () => {
  it("null / undefined = not set (legacy default)", () => {
    expect(parseBillTo(null)).toEqual({ billTo: null })
    expect(parseBillTo(undefined)).toEqual({ billTo: null })
  })
  it("person", () => expect(parseBillTo({ type: "person" })).toEqual({ billTo: { type: "person" } }))
  it("company needs a valid company id", () => {
    expect(parseBillTo({ type: "company", account_id: ACC })).toEqual({ billTo: { type: "company", account_id: ACC } })
    expect(parseBillTo({ type: "company" }).error).toMatch(/pick the company/)
    expect(parseBillTo({ type: "company", account_id: "x" }).error).toMatch(/pick the company/)
  })
  it("existing billing entity", () => {
    expect(parseBillTo({ type: "entity", billing_entity_id: BE })).toEqual({ billTo: { type: "entity", billing_entity_id: BE } })
    expect(parseBillTo({ type: "entity", billing_entity_id: "nope" }).error).toBeTruthy()
  })
  it("typed entity (a lead's company not in the CRM) needs a name; blanks become null", () => {
    expect(parseBillTo({ type: "entity", entity: { name: "  Rossi Srl ", address: "Via Roma 1", vat_number: " " } })).toEqual({
      billTo: { type: "entity", entity: { name: "Rossi Srl", address: "Via Roma 1", country: null, vat_number: null, fiscal_code: null } },
    })
    expect(parseBillTo({ type: "entity", entity: { name: " " } }).error).toMatch(/company name/)
  })
  it("junk is refused", () => {
    expect(parseBillTo("person").error).toBeTruthy()
    expect(parseBillTo({ type: "boss" }).error).toBeTruthy()
    expect(parseBillTo([]).error).toBeTruthy()
  })
})

describe("resolveInvoiceTarget — follows where the offer was made, never guesses", () => {
  it("no choice + company-page offer → the company", () => {
    expect(resolveInvoiceTarget({ billTo: null, offerAccountId: ACC, contactId: "c1" })).toMatchObject({ account_id: ACC, contact_id: "c1" })
  })
  it("no choice + lead/contact offer → the person (no first-company fallback)", () => {
    expect(resolveInvoiceTarget({ billTo: null, offerAccountId: null, contactId: "c1" })).toMatchObject({ account_id: null, contact_id: "c1", billing_entity_id: null, new_entity: null })
  })
  it("person chosen on a company-page offer → the person", () => {
    expect(resolveInvoiceTarget({ billTo: { type: "person" }, offerAccountId: ACC, contactId: "c1" }).account_id).toBeNull()
  })
  it("another company chosen → that company", () => {
    expect(resolveInvoiceTarget({ billTo: { type: "company", account_id: ACC2 }, offerAccountId: ACC, contactId: "c1" }).account_id).toBe(ACC2)
  })
  it("existing billing entity → on the person, printed with that entity", () => {
    expect(resolveInvoiceTarget({ billTo: { type: "entity", billing_entity_id: BE }, offerAccountId: null, contactId: "c1" })).toMatchObject({ account_id: null, billing_entity_id: BE })
  })
  it("typed company (lead paying with his own company) → saved + printed", () => {
    const t = resolveInvoiceTarget({ billTo: { type: "entity", entity: { name: "Rossi Srl" } }, offerAccountId: null, contactId: "c1" })
    expect(t.new_entity).toMatchObject({ name: "Rossi Srl" })
    expect(t.account_id).toBeNull()
  })
  it("an invalid stored value falls back to the context default, never crashes", () => {
    expect(resolveInvoiceTarget({ billTo: { type: "company" }, offerAccountId: ACC, contactId: "c1" }).account_id).toBe(ACC)
  })
})
