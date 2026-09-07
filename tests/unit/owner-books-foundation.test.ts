/**
 * Foundation guards for the owner books, before real statements are loaded.
 *
 * Each of these encodes a defect that was live on 2026-08-30 and would have
 * corrupted or hidden real money. They read the actual source, so removing a fix
 * fails here rather than surfacing months later in a tax figure.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf-8")

describe("the ledger query that feeds the P&L is paged", () => {
  const src = read("lib/owner-finance.ts")
  const fn = src.slice(src.indexOf("export async function getOwnerTransactions("), src.indexOf("export async function getOwnerTransactionsPaginated("))

  it("uses .range() — an un-ranged select is silently capped at 1000 rows", () => {
    // The cap has no error. Uncaught, every headline figure (P&L, dashboard KPIs,
    // Tax tab, cash-flow chart) would compute from only the newest 1000 rows while
    // the Transactions tab reported the true count.
    expect(fn).toContain(".range(offset, offset + PAGE - 1)")
  })

  it("loops until a short page proves completeness", () => {
    expect(fn).toMatch(/if \(page\.length < PAGE\) break/)
  })

  it("orders by a tie-break so paging cannot repeat or skip rows", () => {
    expect(fn).toContain("'id'")
  })
})

describe("paginated transaction list has a stable order", () => {
  const src = read("lib/owner-finance.ts")
  const fn = src.slice(src.indexOf("export async function getOwnerTransactionsPaginated("))

  it("tie-breaks on id — date alone has ties on any real statement", () => {
    // Without this, some rows appear on two pages and an equal number are never
    // shown at all, so they stay uncategorized forever.
    expect(fn).toContain(".order('id', { ascending: false })")
  })
})

describe("statement balances survive the import", () => {
  it("the import row type carries balance_after", () => {
    expect(read("lib/owner-transactions-import.ts")).toMatch(/balance_after\?: number \| null/)
  })

  it("the insert actually writes it", () => {
    // It was parsed correctly and dropped at the point of saving, so the Cash
    // Position (which requires a non-null balance) could never reflect statements.
    expect(read("lib/owner-transactions-import.ts")).toMatch(/balance_after: r\.balance_after \?\? null/)
  })

  it("the upload route passes it through from the parser", () => {
    expect(read("lib/owner-statement-import.ts")).toMatch(/balance_after: t\.balance_after \?\? null/)
  })
})

describe("parse warnings reach the operator", () => {
  const route = read("lib/owner-statement-import.ts")
  const ui = read("app/(dashboard)/owner/transactions-tab.tsx")

  it("the server still returns them", () => {
    expect(route).toContain("warnings: parsed.errors.length > 0")
  })

  it("the upload screen reads them instead of dropping them", () => {
    // The ambiguous-date warning ("assumed M/D/Y") is the one that matters: guess
    // wrong on a European statement and rows near a year boundary land in the
    // WRONG TAX YEAR, since the year is derived from that same date.
    expect(ui).toContain("Array.isArray(d.warnings)")
    expect(ui).toContain("toast.warning")
  })

  it("shows them separately from the success toast, not buried behind it", () => {
    expect(ui).toMatch(/toast\.warning\(w, \{ duration: 15000 \}\)/)
  })

  it("surfaces same-money skips with an example", () => {
    expect(ui).toContain("already in your books from another source")
  })
})

describe("duplicate reporting is split by meaning", () => {
  const route = read("lib/owner-statement-import.ts")

  it("distinguishes a re-uploaded file from money already booked elsewhere", () => {
    expect(route).toContain("skipped_same_source")
    expect(route).toContain("skipped_already_booked")
  })
})
