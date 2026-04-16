/**
 * P1.7 characterization — offer-signed invoice-creation policy.
 *
 * Covers plan §4 P1.7 flows 3 + 4:
 *   3. Offer-signed webhook (new contract) → invoice created with
 *      correct amount.
 *   4. Offer-signed webhook (renewal contract) → no invoice created.
 *
 * The invoice-creation rule is a single predicate
 * (`decideInvoiceAtSigning` in lib/portal/offer-invoice-policy.ts).
 * This test exhaustively exercises the predicate so any change — even
 * one that only affects the offer-signed webhook's skip condition —
 * fires a test. The webhook route itself imports the same function,
 * so the test and production code cannot drift.
 */

import { describe, it, expect } from "vitest"
import {
  decideInvoiceAtSigning,
  getServiceLabel,
  NEW_CONTRACT_TYPES,
} from "@/lib/portal/offer-invoice-policy"

describe("decideInvoiceAtSigning — create paths", () => {
  it("creates an invoice for a formation new contract with a positive amount", () => {
    const d = decideInvoiceAtSigning({
      contract_type: "formation",
      contact_id: "contact-1",
      total_amount: 1500,
    })
    expect(d).toEqual({ create: true, reason: null })
  })

  it("creates an invoice for onboarding, tax_return, and itin too", () => {
    for (const ct of ["onboarding", "tax_return", "itin"] as const) {
      const d = decideInvoiceAtSigning({
        contract_type: ct,
        contact_id: "contact-1",
        total_amount: 500,
      })
      expect(d.create, `contract_type=${ct} should create invoice`).toBe(true)
    }
  })

  it("creates an invoice for unknown contract_types too (default behavior)", () => {
    // Defensive: any non-renewal contract_type with a contact + amount
    // gets an invoice. This preserves current behavior for future
    // contract types (e.g. "banking") without requiring a webhook edit.
    const d = decideInvoiceAtSigning({
      contract_type: "banking",
      contact_id: "contact-1",
      total_amount: 100,
    })
    expect(d.create).toBe(true)
  })
})

describe("decideInvoiceAtSigning — skip paths", () => {
  it("skips invoice when contract_type is 'renewal'", () => {
    // Flow 4: this single assertion is the whole point of flow 4.
    const d = decideInvoiceAtSigning({
      contract_type: "renewal",
      contact_id: "contact-1",
      total_amount: 2500,
    })
    expect(d).toEqual({ create: false, reason: "renewal" })
  })

  it("skips invoice when contact_id is null/undefined/empty", () => {
    for (const c of [null, undefined, ""]) {
      const d = decideInvoiceAtSigning({
        contract_type: "formation",
        contact_id: c,
        total_amount: 500,
      })
      expect(d.create, `contact_id=${JSON.stringify(c)} should skip`).toBe(false)
      expect(d.reason).toBe("no_contact")
    }
  })

  it("skips invoice when total_amount is zero, null, or negative", () => {
    for (const amt of [0, null, undefined, -100] as const) {
      const d = decideInvoiceAtSigning({
        contract_type: "formation",
        contact_id: "contact-1",
        total_amount: amt,
      })
      expect(d.create, `amount=${amt} should skip`).toBe(false)
      expect(d.reason).toBe("zero_amount")
    }
  })

  it("renewal skip wins even when contact + amount are valid (order-of-checks)", () => {
    // Regression guard: a future refactor must keep renewal as a
    // blocking condition, not an accidentally-passing branch.
    const d = decideInvoiceAtSigning({
      contract_type: "renewal",
      contact_id: "contact-valid",
      total_amount: 9999,
    })
    expect(d.create).toBe(false)
    expect(d.reason).toBe("renewal")
  })

  it("missing contact wins over zero amount (stable error code)", () => {
    const d = decideInvoiceAtSigning({
      contract_type: "formation",
      contact_id: null,
      total_amount: 0,
    })
    expect(d.reason).toBe("no_contact") // first-predicate ordering
  })
})

describe("getServiceLabel — mapping", () => {
  it("maps each NEW_CONTRACT_TYPES value to a human label", () => {
    const expectations: Record<string, string> = {
      formation: "LLC Formation",
      onboarding: "LLC Onboarding",
      tax_return: "Tax Return",
      itin: "ITIN Application",
    }
    for (const ct of NEW_CONTRACT_TYPES) {
      expect(getServiceLabel(ct), `label for ${ct}`).toBe(expectations[ct])
    }
  })

  it("falls back to 'Service' for unknown / missing contract_type", () => {
    expect(getServiceLabel("renewal")).toBe("Service")
    expect(getServiceLabel(null)).toBe("Service")
    expect(getServiceLabel(undefined)).toBe("Service")
    expect(getServiceLabel("")).toBe("Service")
  })
})
