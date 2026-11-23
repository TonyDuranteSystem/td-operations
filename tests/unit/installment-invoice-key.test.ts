/**
 * The yearly installments (dev job bea928e0, Antonio 2026-11-22).
 *
 * An installment is not a free "invoice type": it comes from the CRM's installment amounts, and an invoice carries an
 * installment label and its year TOGETHER or not at all. Remove the pair rule and the first block fails; change a key and
 * the "same key as the system writers" block fails (a manual installment would then be billed a second time next to the
 * system-made one); let a one-off label back into the schema and the schema block fails.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  INSTALLMENT_LABELS,
  installmentNumberOf,
  installmentIdempotencyKey,
  installmentPairProblem,
} from "@/lib/billing/installment-invoice-key"
import { createInvoiceSchema } from "@/lib/schemas/invoice"

const ACCT = "30c2cd96-03e4-43cf-9536-81d961b18b1d"
const baseInvoice = {
  account_id: ACCT,
  description: "Shipping Service",
  amount_currency: "USD" as const,
  issue_date: "2026-11-22",
  items: [{ description: "Shipping Service", quantity: 1, unit_price: 100, amount: 100, sort_order: 0 }],
}

describe("the two installment labels", () => {
  it("are exactly the two the database rules and the paid handler read (never renamed)", () => {
    expect([...INSTALLMENT_LABELS]).toEqual(["Installment 1 (Jan)", "Installment 2 (Jun)"])
  })

  it("numbers them 1 and 2, and nothing else", () => {
    expect(installmentNumberOf("Installment 1 (Jan)")).toBe(1)
    expect(installmentNumberOf("Installment 2 (Jun)")).toBe(2)
    for (const other of ["Setup Fee", "One-Time Service", "Custom", "Annual Payment", "ITIN", "installment 1 (jan)", "", null, undefined]) {
      expect(installmentNumberOf(other as string | null | undefined)).toBeNull()
    }
  })
})

describe("the key of an installment invoice is the SAME string the system writers use", () => {
  it("January = renewal-1st:{account}:{year}; June = annual-installment:{account}:2:{year}", () => {
    expect(installmentIdempotencyKey(ACCT, "Installment 1 (Jan)", 2026)).toBe(`renewal-1st:${ACCT}:2026`)
    expect(installmentIdempotencyKey(ACCT, "Installment 2 (Jun)", 2026)).toBe(`annual-installment:${ACCT}:2:2026`)
  })

  it("is null for anything that is not an installment", () => {
    expect(installmentIdempotencyKey(ACCT, "Setup Fee", 2026)).toBeNull()
    expect(installmentIdempotencyKey(ACCT, undefined, 2026)).toBeNull()
  })

  it("matches the contract signing's key (so a late contract does not bill the January installment twice)", () => {
    const src = readFileSync(join(process.cwd(), "lib/offers/process-agreement-signed.ts"), "utf8")
    expect(src).toMatch(/`renewal-1st:\$\{agreement\.account_id\}:\$\{year\}`/)
  })

  it("matches the yearly run's key (so a manual June installment and the run are one invoice)", () => {
    const src = readFileSync(join(process.cwd(), "app/api/cron/annual-installments/route.ts"), "utf8")
    expect(src).toMatch(/`annual-installment:\$\{acct\.id\}:\$\{installmentNumber\}:\$\{year\}`/)
  })
})

describe("installmentPairProblem — a label and its year come together", () => {
  it("accepts nothing at all (a one-off invoice) and a complete pair", () => {
    expect(installmentPairProblem({})).toBeNull()
    expect(installmentPairProblem({ installment: undefined, year: undefined })).toBeNull()
    expect(installmentPairProblem({ installment: "Installment 1 (Jan)", year: 2026 })).toBeNull()
  })

  it("refuses a label without a year", () => {
    expect(installmentPairProblem({ installment: "Installment 2 (Jun)" })).toMatch(/needs the year/)
  })

  it("refuses a year without a label — no one-off invoice carries a year", () => {
    expect(installmentPairProblem({ year: 2026 })).toMatch(/only be set on an installment/)
  })

  it("refuses a one-off label — only the two installments carry a Payment Type", () => {
    expect(installmentPairProblem({ installment: "Setup Fee", year: 2026 })).toMatch(/Only the two yearly installments/)
    expect(installmentPairProblem({ installment: "One-Time Service" })).toMatch(/Only the two yearly installments/)
  })
})

describe("createInvoiceSchema — what the CRM invoice window can send", () => {
  it("accepts a one-off invoice with no Payment Type and no year", () => {
    expect(createInvoiceSchema.safeParse(baseInvoice).success).toBe(true)
  })

  it("accepts an installment with ITS year", () => {
    expect(createInvoiceSchema.safeParse({ ...baseInvoice, installment: "Installment 1 (Jan)", year: 2026 }).success).toBe(true)
  })

  it("rejects an installment without a year, and a year without an installment", () => {
    expect(createInvoiceSchema.safeParse({ ...baseInvoice, installment: "Installment 1 (Jan)" }).success).toBe(false)
    expect(createInvoiceSchema.safeParse({ ...baseInvoice, year: 2026 }).success).toBe(false)
  })

  it.each(["Setup Fee", "One-Time Service", "Custom", "Annual Payment", "ITIN", "One-Time"])("rejects the old one-off label %s", (label) => {
    expect(createInvoiceSchema.safeParse({ ...baseInvoice, installment: label, year: 2026 }).success).toBe(false)
  })
})
