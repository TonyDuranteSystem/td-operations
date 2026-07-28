import { describe, it, expect } from "vitest"
import { toPaymentEnumStatus } from "@/lib/portal/unified-invoice"
import { toExpenseStatus } from "@/lib/portal/td-invoice"

/**
 * The two invoice status columns speak DIFFERENT vocabularies, and so does the client-facing
 * expense mirror. An unmapped value is not a cosmetic bug: Postgres rejects the ENTIRE update
 * and the legacy writers historically discarded the error — which is how un-marking a
 * renegotiated Overdue invoice reported success while changing nothing (Shoppyverse,
 * INV-002295, 2026-07-28). These tests pin the mappings to the vocabularies verified against
 * production that day.
 */
describe("toPaymentEnumStatus — invoice lifecycle → payment_status enum", () => {
  it("maps the lifecycle-only values to Pending (the enum has no Sent/Partial/Draft)", () => {
    expect(toPaymentEnumStatus("Sent")).toBe("Pending")
    expect(toPaymentEnumStatus("Partial")).toBe("Pending")
    expect(toPaymentEnumStatus("Draft")).toBe("Pending")
  })

  it("passes through the labels that exist in both vocabularies", () => {
    for (const s of ["Paid", "Overdue", "Cancelled", "Waived", "Refunded", "Pending"]) {
      expect(toPaymentEnumStatus(s)).toBe(s)
    }
  })
})

describe("toExpenseStatus — invoice status → client expense mirror (CHECK: Pending/Paid/Overdue/Cancelled)", () => {
  it("open-but-not-yet-due reads as Pending to the client", () => {
    expect(toExpenseStatus("Sent")).toBe("Pending")
    expect(toExpenseStatus("Draft")).toBe("Pending")
    expect(toExpenseStatus("Partial")).toBe("Pending")
    expect(toExpenseStatus("Pending")).toBe("Pending")
  })

  it("terminal and overdue values map to themselves (Split collapses to Cancelled)", () => {
    expect(toExpenseStatus("Paid")).toBe("Paid")
    expect(toExpenseStatus("Overdue")).toBe("Overdue")
    expect(toExpenseStatus("Cancelled")).toBe("Cancelled")
    expect(toExpenseStatus("Split")).toBe("Cancelled")
  })

  it("every value the dunning flip can produce lands inside the mirror's CHECK", () => {
    const mirrorAllowed = new Set(["Pending", "Paid", "Overdue", "Cancelled"])
    for (const s of ["Sent", "Partial"]) {
      expect(mirrorAllowed.has(toExpenseStatus(s))).toBe(true)
    }
  })
})
