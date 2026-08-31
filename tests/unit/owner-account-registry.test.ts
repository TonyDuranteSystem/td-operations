/**
 * The account registry exists so that what the system learns about an account
 * SURVIVES. The Amex sign inversion was repaired across 809 rows by hand on
 * 2026-08-31; without the convention written down, the next Amex import would
 * silently undo that repair and put roughly $80,457 of spending back into the
 * books as income.
 *
 * These read the real source, so loosening either side fails.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const importer = readFileSync(join(process.cwd(), "lib/owner-statement-import.ts"), "utf-8")
const migration = readFileSync(
  join(process.cwd(), "scripts/migrations/20260831-1200-owner-books-accounts-registry.sql"), "utf-8")

describe("the sign convention is a fact about the ACCOUNT, not the file", () => {
  it("the importer reads it from the registry before mapping rows", () => {
    expect(importer).toContain("from('td_books_accounts'")
    expect(importer).toMatch(/sign_convention/)
    // Read BEFORE the row map, or the flip cannot be applied.
    expect(importer.indexOf("const flip")).toBeLessThan(importer.indexOf("allRows: OwnerImportRow[]"))
  })

  it("an inverted account negates the AMOUNT", () => {
    expect(importer).toMatch(/amount: flip \? -t\.amount : t\.amount/)
  })

  it("CRITICAL: it does NOT negate the stated balance", () => {
    // A liability statement prints the amount OWED while the amounts are the
    // CHANGE in it. Negating both breaks the chain the flip exists to make true —
    // proven on the loan's June rows: 144,500 + (-284.39) = 144,215.61 as stated.
    expect(importer).not.toMatch(/balance_after: .*-t\.balance_after/)
    expect(importer).toMatch(/balance_after: t\.balance_after \?\? null/)
  })

  it("fails OPEN — an account with no registry row imports as written", () => {
    // A missing row must never silently reverse a file.
    expect(importer).toMatch(/if \(error \|\| !data\) return null/)
    expect(importer).toMatch(/facts\?\.sign_convention === 'inverted'/)
  })
})

describe("the registry records what a balance sheet needs", () => {
  it("constrains account type, because type drives the accounting", () => {
    // A card and a loan are liabilities; their balances are money owed and can
    // never be summed into cash.
    for (const t of ["checking", "savings", "credit_card", "loan", "processor"]) {
      expect(migration).toContain(`'${t}'`)
    }
  })

  it("carries the clearing flag", () => {
    // Stripe ties to its own report, never to a bank, and its payouts are
    // transfers — the distinction that prevents a six-figure double-count.
    expect(migration).toMatch(/is_clearing/)
  })

  it("records the PROVENANCE of every balance", () => {
    // A figure derived from transaction rows is not the same kind of fact as one
    // read off the institution's own statement.
    for (const s of ["statement", "derived", "provider_report", "unknown"]) {
      expect(migration).toContain(`'${s}'`)
    }
  })

  it("one row per account per entity", () => {
    expect(migration).toMatch(/UNIQUE \(entity_id, bank_name\)/)
  })
})
