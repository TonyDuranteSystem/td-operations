/**
 * Wave 2 (card 4a39e0fd) — statement-failure DIAGNOSIS.
 * Antonio's rule: "tell the client what's wrong, never ask him why." The three
 * cases are the three REAL failures of the week: PAMAG (wrong year), Nova
 * Ratio (QuickBooks export), Economicamente (empty month). One copy source for
 * the chat message AND the file card — they can never contradict again.
 */
import { describe, it, expect } from "vitest"
import { sniffAccountingExport, diagnosisCopy } from "@/lib/tax/ingest-diagnosis"

describe("sniffAccountingExport", () => {
  it("recognises a QuickBooks transaction export", () => {
    const r = sniffAccountingExport('"Date","Transaction Type","Num","Posting","Memo/Description","Amount"')
    expect(r).toEqual({ isAccountingExport: true, software: "QuickBooks" })
  })

  it("recognises a Xero journal export", () => {
    const r = sniffAccountingExport("Journal Number,Date,Account Code,Description,Gross,Net")
    expect(r.isAccountingExport).toBe(true)
    expect(r.software).toBe("Xero")
  })

  it("recognises a generic double-entry ledger export", () => {
    expect(sniffAccountingExport("Account Code,Description,Debit,Credit").isAccountingExport).toBe(true)
  })

  it("does NOT misbrand a real bank CSV — one odd column is not enough", () => {
    // Relay-style bank export
    expect(sniffAccountingExport("Date,Description,Amount,Balance").isAccountingExport).toBe(false)
    // A bank CSV that happens to have a "Split" column alone
    expect(sniffAccountingExport("Date,Description,Split,Amount").isAccountingExport).toBe(false)
    // Debit/Credit alone (some banks export both columns) without ledger signals
    expect(sniffAccountingExport("Date,Description,Debit,Credit,Balance").isAccountingExport).toBe(false)
    expect(sniffAccountingExport("").isAccountingExport).toBe(false)
  })
})

describe("diagnosisCopy — every code speaks both languages and states the fix", () => {
  it("wrong_year names BOTH years (the PAMAG shape)", () => {
    const c = diagnosisCopy({ code: "wrong_year", found_years: [2026], expected_year: 2025 })
    expect(c.en).toContain("2026")
    expect(c.en).toContain("we need 2025")
    expect(c.en).toContain("January 1 to December 31")
    expect(c.it).toContain("2026")
    expect(c.it).toContain("1 gennaio")
  })

  it("not_bank_statement points at the BANK's own CSV (the Nova Ratio shape)", () => {
    const c = diagnosisCopy({ code: "not_bank_statement", software: "QuickBooks" })
    expect(c.en).toContain("QuickBooks")
    expect(c.en).toContain("download the transactions CSV from your bank")
    expect(c.it).toContain("estratto conto")
  })

  it("empty_period asks only for the inactivity confirmation (the Economicamente shape)", () => {
    const c = diagnosisCopy({ code: "empty_period" })
    expect(c.en).toContain("read correctly")
    expect(c.en).toContain("Year coverage")
    expect(c.it).toContain("Copertura dell'anno")
  })

  it("unreadable (and a missing diagnosis) fall back to the replace instruction — never 'no action needed'", () => {
    for (const c of [diagnosisCopy({ code: "unreadable" }), diagnosisCopy(null), diagnosisCopy(undefined)]) {
      expect(c.en).toContain("upload the statement exactly as your bank exports it")
      expect(c.en.toLowerCase()).not.toContain("no action")
      expect(c.it).toContain("esattamente come lo esporta la tua banca")
    }
  })

  it("every code returns BOTH languages, non-empty", () => {
    for (const code of ["wrong_year", "not_bank_statement", "empty_period", "unreadable"] as const) {
      const c = diagnosisCopy({ code })
      expect(c.en.length).toBeGreaterThan(30)
      expect(c.it.length).toBeGreaterThan(30)
    }
  })
})
