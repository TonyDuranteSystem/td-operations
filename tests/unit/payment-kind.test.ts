import { describe, it, expect } from "vitest"
import {
  isNonClientPayment,
  readPaymentKind,
  PAYMENT_KIND_MARKETING,
  PAYMENT_KIND_SERVICE_SALE,
} from "@/lib/payments/payment-kind"

describe("payment kind tag", () => {
  it("no tag = normal client payment (legacy checkouts unchanged)", () => {
    expect(isNonClientPayment(null)).toBe(false)
    expect(isNonClientPayment(undefined)).toBe(false)
    expect(isNonClientPayment({})).toBe(false)
    expect(isNonClientPayment({ offer_token: "abc", invoice_number: "" })).toBe(false)
  })
  it("empty or blank tag counts as no tag", () => {
    expect(isNonClientPayment({ payment_kind: "" })).toBe(false)
    expect(isNonClientPayment({ payment_kind: "   " })).toBe(false)
    expect(readPaymentKind({ payment_kind: "  " })).toBeNull()
  })
  it("explicit service_sale keeps the client effects", () => {
    expect(isNonClientPayment({ payment_kind: PAYMENT_KIND_SERVICE_SALE })).toBe(false)
    expect(isNonClientPayment({ payment_kind: " service_sale " })).toBe(false)
  })
  it("marketing tag blocks them", () => {
    expect(isNonClientPayment({ payment_kind: PAYMENT_KIND_MARKETING })).toBe(true)
  })
  it("any other tag value is default-deny (typo, future kind, wrong case)", () => {
    for (const v of ["marketing", "Service_Sale", "service-sale", "refund", "x"]) {
      expect(isNonClientPayment({ payment_kind: v })).toBe(true)
    }
  })
  it("tag works even when it arrives alongside client identifiers", () => {
    expect(
      isNonClientPayment({
        payment_kind: PAYMENT_KIND_MARKETING,
        offer_token: "tok",
        invoice_number: "INV-000123",
        client_email: "existing.client@example.com",
        lead_id: "lead-1",
      }),
    ).toBe(true)
  })
})
