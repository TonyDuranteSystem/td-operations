import { describe, it, expect } from "vitest"
import { parseAmountCents, parseLinkRequest, linkMetadata, CONFIRM_ABOVE, MAX_AMOUNT, DEFAULT_DESCRIPTION } from "@/lib/incoming-payments/payment-link"
import { isUnlabelledPayment } from "@/lib/incoming-payments/classify"
import { isNonClientPayment, readPaymentKind } from "@/lib/payments/payment-kind"

const LEAD = "131b5d4a-2800-4bc8-9104-a955fae8e62a"
const ok = (over: Record<string, unknown> = {}) => parseLinkRequest({ lead_id: LEAD, amount: "397", currency: "eur", description: "Strategic call", purpose: "paid_call", ...over })

describe("parseAmountCents — a free amount, but never guessed", () => {
  it.each([["397", 39700], ["397.5", 39750], ["397,50", 39750], [397, 39700], [" 1250 ", 125000], ["0.01", 1]])("%s -> %s cents", (raw, cents) => {
    expect(parseAmountCents(raw)).toBe(cents)
  })
  it.each(["", "0", "-5", "abc", "1.234,50", "1,234.50", "397.555", "12e3", "50001", "1000000", null, undefined, {}])("rejects %j", raw => {
    expect(parseAmountCents(raw)).toBeNull()
  })
  it("allows exactly the maximum", () => expect(parseAmountCents(String(MAX_AMOUNT))).toBe(MAX_AMOUNT * 100))
})

describe("parseLinkRequest", () => {
  it("accepts a normal request and normalises it", () => {
    const r = ok()
    expect(r).toMatchObject({ ok: true, needsConfirm: false, value: { leadId: LEAD, amountCents: 39700, currency: "EUR", description: "Strategic call", purpose: "paid_call" } })
  })
  it("the description is free; empty falls back to the default; whitespace is tidied; too long is refused", () => {
    expect(ok({ description: "  Call   with   Chris " })).toMatchObject({ ok: true, value: { description: "Call with Chris" } })
    expect(ok({ description: "" })).toMatchObject({ ok: true, value: { description: DEFAULT_DESCRIPTION } })
    expect(ok({ description: "x".repeat(81) })).toMatchObject({ ok: false })
  })
  it("purpose defaults to a paid call, accepts 'other', refuses anything else (never a free-text kind)", () => {
    expect(ok({ purpose: undefined })).toMatchObject({ ok: true, value: { purpose: "paid_call" } })
    expect(ok({ purpose: "other" })).toMatchObject({ ok: true, value: { purpose: "other" } })
    for (const bad of ["service_sale", "marketing_sale", "convert_lead", ""]) expect(ok({ purpose: bad }).ok).toBe(false)
  })
  it("refuses a bad lead id, currency or amount with a plain message", () => {
    expect(ok({ lead_id: "nope" })).toMatchObject({ ok: false })
    expect(ok({ currency: "GBP" })).toMatchObject({ ok: false })
    expect(ok({ amount: "abc" })).toMatchObject({ ok: false })
  })
  it("a large amount needs the tick, and the tick must be exactly true", () => {
    const big = String(CONFIRM_ABOVE + 1)
    expect(ok({ amount: big })).toMatchObject({ ok: true, needsConfirm: true })
    expect(ok({ amount: big, confirmed: "true" })).toMatchObject({ needsConfirm: true })
    expect(ok({ amount: big, confirmed: true })).toMatchObject({ needsConfirm: false })
    expect(ok({ amount: String(CONFIRM_ABOVE) })).toMatchObject({ needsConfirm: false })
  })
})

describe("linkMetadata — what the link says about itself", () => {
  it("a paid-call link carries the paid_call kind: client effects are skipped and the webhook records it", () => {
    const m = linkMetadata({ leadId: LEAD, purpose: "paid_call" }, "chris@example.com")
    expect(readPaymentKind(m)).toBe("paid_call")
    expect(isNonClientPayment(m)).toBe(true)
    expect(m.crm_lead_ref).toBe(LEAD)
    expect(m.client_email).toBe("chris@example.com")
  })
  it("an 'other' link carries NO label key, so it waits in Payments to confirm and can never convert the lead", () => {
    const m = linkMetadata({ leadId: LEAD, purpose: "other" }, null)
    expect(readPaymentKind(m)).toBeNull()
    expect(isNonClientPayment(m)).toBe(false)
    expect(isUnlabelledPayment({ mode: "payment", metadata: m })).toBe(true)
    expect(m.client_email).toBeUndefined()
  })
  it("never uses a key that would make Stripe's session look like one of OUR sales (source / offer_token / invoice_number / lead_id)", () => {
    for (const purpose of ["paid_call", "other"] as const) {
      const keys = Object.keys(linkMetadata({ leadId: LEAD, purpose }, "a@b.c"))
      for (const forbidden of ["source", "offer_token", "invoice_number", "lead_id"]) expect(keys).not.toContain(forbidden)
    }
  })
})
