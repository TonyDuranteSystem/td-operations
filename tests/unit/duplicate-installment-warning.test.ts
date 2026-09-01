import { describe, it, expect } from "vitest"
import { buildDuplicateInstallmentWarning } from "@/lib/portal/td-invoice"

describe("buildDuplicateInstallmentWarning", () => {
  it("returns undefined when there are no existing matches", () => {
    expect(buildDuplicateInstallmentWarning([], 2, 2026)).toBeUndefined()
  })

  it("names the single existing invoice (ShoppyVerse shape: one prior duplicate)", () => {
    const msg = buildDuplicateInstallmentWarning([{ invoice_number: "INV-002295" }], 2, 2026)
    expect(msg).toContain("an invoice")
    expect(msg).toContain("Installment 2 (2026)")
    expect(msg).toContain("INV-002295")
    expect(msg).toContain("duplicate")
  })

  it("pluralizes and lists every invoice number when more than one exists", () => {
    const msg = buildDuplicateInstallmentWarning(
      [{ invoice_number: "INV-001111" }, { invoice_number: "INV-002222" }],
      1,
      2026,
    )
    expect(msg).toContain("2 invoices")
    expect(msg).toContain("Installment 1 (2026)")
    expect(msg).toContain("INV-001111, INV-002222")
  })

  it("still returns a warning when an invoice number is missing (dropped, not filtered out)", () => {
    const msg = buildDuplicateInstallmentWarning([{ invoice_number: null }], 2, 2026)
    expect(msg).toBeDefined()
    expect(msg).toContain("an invoice")
  })
})
