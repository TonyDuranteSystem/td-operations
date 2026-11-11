import { describe, it, expect } from "vitest"
import { payerOfPartOne, samePayer } from "@/lib/plan-invoices/payer"

/**
 * Who a later part is billed to (dev job ae3c19db, end-to-end QA). Production had an offer with no "Invoice to": part 1 went to the
 * person who signed, part 2 to the company the offer was linked to afterwards. Antonio: "the one who has to pay is the one who
 * originally signed the contract". A Draft made on the company page can also sit on a part and must not be emailed as if it were the signer's.
 */
const one = (over: Record<string, unknown>) => ({ tranche_seq: 1, invoice_status: "Paid", account_id: null, contact_id: null, billing_entity_id: null, ...over }) as never

describe("payerOfPartOne — where part 1 actually went", () => {
  it("is the person when part 1 was billed to the person", () => {
    expect(payerOfPartOne([one({ contact_id: "c1" })])).toEqual({ account_id: null, contact_id: "c1", billing_entity_id: null })
  })
  it("is the company (with the signer) when part 1 was billed to a company", () => {
    expect(payerOfPartOne([one({ account_id: "a1", contact_id: "c1" })])).toEqual({ account_id: "a1", contact_id: "c1", billing_entity_id: null })
  })
  it("prefers the live part-1 invoice over a cancelled one", () => {
    expect(payerOfPartOne([one({ invoice_status: "Cancelled", account_id: "old" }), one({ contact_id: "c1" })])?.account_id).toBeNull()
  })
  it("falls back to a cancelled part-1 invoice when it is all there is", () => {
    expect(payerOfPartOne([one({ invoice_status: "Cancelled", contact_id: "c1" })])?.contact_id).toBe("c1")
  })
  it("is null when part 1 has no invoice (or only other parts do)", () => {
    expect(payerOfPartOne([])).toBeNull()
    expect(payerOfPartOne([one({ tranche_seq: 2, contact_id: "c1" })])).toBeNull()
    expect(payerOfPartOne([one({})])).toBeNull()
  })
})

describe("samePayer — is this invoice addressed to the payer the offer names?", () => {
  const person = { account_id: null, contact_id: "c1", billing_entity_id: null }
  it("a person-billed invoice matches the person", () => {
    expect(samePayer(person, person)).toBe(true)
  })
  it("a company invoice does not match a person target (the company-page Draft case)", () => {
    expect(samePayer({ account_id: "a1", contact_id: null, billing_entity_id: null }, person)).toBe(false)
  })
  it("a different person does not match", () => {
    expect(samePayer({ ...person, contact_id: "c2" }, person)).toBe(false)
  })
  it("a company target matches on the company; the signer being on the invoice too is not a difference", () => {
    const target = { account_id: "a1", contact_id: "c1", billing_entity_id: null }
    expect(samePayer({ account_id: "a1", contact_id: null, billing_entity_id: null }, target)).toBe(true)
    expect(samePayer({ account_id: "a1", contact_id: "c1", billing_entity_id: null }, target)).toBe(true)
    expect(samePayer({ account_id: "a2", contact_id: "c1", billing_entity_id: null }, target)).toBe(false)
  })
  it("a billing entity must match exactly", () => {
    const target = { account_id: null, contact_id: "c1", billing_entity_id: "e1" }
    expect(samePayer({ account_id: null, contact_id: "c1", billing_entity_id: "e1" }, target)).toBe(true)
    expect(samePayer({ account_id: null, contact_id: "c1", billing_entity_id: null }, target)).toBe(false)
  })
})
