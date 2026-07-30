/**
 * What un-matching a payment does NOT undo — and whether we say so.
 *
 * Modelled on the real 2026-07-22 case: the mis-match lifted the client's 2025 tax-return
 * payment gate and sent an internal hand-off email, and the correction reversed neither.
 */

import { describe, it, expect } from "vitest"
import {
  describeReversalSideEffects,
  resolveTargetTaxYear,
} from "@/lib/finance/reversal-side-effects"

describe("resolveTargetTaxYear", () => {
  it("an annual installment for year N pays for the tax return of year N-1", () => {
    expect(resolveTargetTaxYear({ installment: "Installment 2 (Jun)", description: null, year: 2026 })).toBe(2025)
    expect(resolveTargetTaxYear({ installment: "Installment 1 (Jan)", description: null, year: 2026 })).toBe(2025)
  })

  it("a direct tax-return payment maps to its own year", () => {
    expect(resolveTargetTaxYear({ installment: null, description: "Tax Return 2025 preparation", year: 2025 })).toBe(2025)
    expect(resolveTargetTaxYear({ installment: null, description: "TAX FILING fee", year: 2024 })).toBe(2024)
  })

  it("anything else is not a tax-linked payment", () => {
    expect(resolveTargetTaxYear({ installment: null, description: "EIN Change Name", year: 2026 })).toBeNull()
    expect(resolveTargetTaxYear({ installment: "Installment 2 (Jun)", description: null, year: null })).toBeNull()
  })
})

describe("describeReversalSideEffects — the Aces case", () => {
  // The real row: an "Installment 2 (Jun)" invoice for billing year 2026, whose 2025 tax
  // return had already moved to "Data Received" and whose Installment 1 was also paid.
  const acesLike = {
    invoiceNumber: "INV-002151",
    installment: "Installment 2 (Jun)",
    description: "2nd Installment 2026 — LLC Annual Management",
    year: 2026,
    taxReturn: { tax_year: 2025, paid: true, status: "Data Received" },
    otherPaidPaymentExists: true,
  }

  it("says the tax gate stays open and needs a human", () => {
    const out = describeReversalSideEffects(acesLike)
    expect(out.targetTaxYear).toBe(2025)
    expect(out.needsAttention).toBe(true)
    expect(out.statements.some((s) => s.includes("stays OPEN"))).toBe(true)
  })

  it("says the internal hand-off email cannot be unsent", () => {
    const out = describeReversalSideEffects(acesLike)
    expect(out.statements.some((s) => s.includes("cannot be unsent"))).toBe(true)
  })

  it("names WHY the gate will not roll back", () => {
    const otherPayment = describeReversalSideEffects(acesLike)
    expect(otherPayment.statements.join(" ")).toContain("another payment for the same year")

    const progressed = describeReversalSideEffects({ ...acesLike, otherPaidPaymentExists: false })
    expect(progressed.statements.join(" ")).toContain('"Data Received"')
  })
})

describe("describeReversalSideEffects — the cases that ARE self-cleaning", () => {
  it("an early-stage return with no other paid payment rolls back automatically", () => {
    const out = describeReversalSideEffects({
      invoiceNumber: "INV-1",
      installment: "Installment 2 (Jun)",
      description: null,
      year: 2026,
      taxReturn: { tax_year: 2025, paid: true, status: "Activated - Need Link" },
      otherPaidPaymentExists: false,
    })
    expect(out.statements.some((s) => s.includes("close again automatically"))).toBe(true)
    // Still flagged, because the hand-off email went out regardless.
    expect(out.needsAttention).toBe(true)
  })

  it("a non-tax invoice sets nothing in motion", () => {
    const out = describeReversalSideEffects({
      invoiceNumber: "INV-002104",
      installment: null,
      description: "EIN Change Name",
      year: null,
      taxReturn: null,
      otherPaidPaymentExists: false,
    })
    expect(out.statements).toEqual([])
    expect(out.needsAttention).toBe(false)
    expect(out.targetTaxYear).toBeNull()
  })

  it("a tax-linked invoice whose return was never marked paid says nothing about the gate", () => {
    const out = describeReversalSideEffects({
      invoiceNumber: "INV-1",
      installment: null,
      description: "Tax Return 2025",
      year: 2025,
      taxReturn: { tax_year: 2025, paid: false, status: "Payment Pending" },
      otherPaidPaymentExists: false,
    })
    expect(out.statements).toEqual([])
    expect(out.needsAttention).toBe(false)
  })
})
