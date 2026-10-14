import { describe, it, expect } from "vitest"
import { pickWelcomeDocs, type WelcomeDocRow } from "@/lib/operations/welcome-docs"
import { pickStatementRecords, type StatementRecord } from "@/lib/operations/bank-statement-files"

const doc = (o: Partial<WelcomeDocRow>): WelcomeDocRow => ({
  drive_file_id: "store:1", file_name: "f.pdf", document_type_name: "EIN Letter (IRS)", status: "classified", created_at: "2026-01-01", ...o,
})

describe("pickWelcomeDocs", () => {
  it("finds the EIN letter and the Articles from the records", () => {
    const r = pickWelcomeDocs([
      doc({ drive_file_id: "store:ein", document_type_name: "EIN Letter (IRS)" }),
      doc({ drive_file_id: "store:art", document_type_name: "Articles of Organization" }),
    ])
    expect(r.ein?.pointer).toBe("store:ein")
    expect(r.articles?.pointer).toBe("store:art")
  })
  it("takes the newest of several", () => {
    const r = pickWelcomeDocs([
      doc({ drive_file_id: "old", created_at: "2025-01-01" }),
      doc({ drive_file_id: "new", created_at: "2026-05-01" }),
    ])
    expect(r.ein?.pointer).toBe("new")
  })
  it("ignores archived records, records without a pointer, and other types", () => {
    const r = pickWelcomeDocs([
      doc({ drive_file_id: "gone", status: "archived" }),
      doc({ drive_file_id: null }),
      doc({ drive_file_id: "x", document_type_name: "EIN Cancellation Request" }),
    ])
    expect(r.ein).toBeNull()
    expect(r.articles).toBeNull()
  })
  it("falls back to an EIN confirmation fax only when no typed EIN letter exists", () => {
    const fax = doc({ drive_file_id: "fax", document_type_name: "IRS Fax", file_name: "IRS EIN confirmation fax LTR 147C.pdf" })
    expect(pickWelcomeDocs([fax]).ein?.pointer).toBe("fax")
    expect(pickWelcomeDocs([fax, doc({ drive_file_id: "typed" })]).ein?.pointer).toBe("typed")
    expect(pickWelcomeDocs([doc({ drive_file_id: "other", document_type_name: "IRS Fax", file_name: "SS-4 fax.pdf" })]).ein).toBeNull()
  })
  it("returns nothing for no records", () => {
    expect(pickWelcomeDocs([])).toEqual({ ein: null, articles: null })
  })
})

const st = (o: Partial<StatementRecord>): StatementRecord => ({
  drive_file_id: "store:s1", file_name: "Wise Jan.csv", mime_type: "text/csv", document_type_name: "Bank Statement", tax_year: 2025, status: "classified", ...o,
})

describe("pickStatementRecords", () => {
  it("takes the statements of the asked year", () => {
    const r = pickStatementRecords([st({}), st({ drive_file_id: "store:s2", tax_year: 2024 })], 2025)
    expect(r.files.map((f) => f.id)).toEqual(["store:s1"])
    expect(r.undated).toBe(0)
  })
  it("takes an undated record only when its name carries the year, and counts the rest", () => {
    const r = pickStatementRecords([
      st({ drive_file_id: "a", tax_year: null, file_name: "Mercury 2025-03.pdf" }),
      st({ drive_file_id: "b", tax_year: null, file_name: "Mercury march.pdf" }),
    ], 2025)
    expect(r.files.map((f) => f.id)).toEqual(["a"])
    expect(r.undated).toBe(1)
  })
  it("skips archived, non-statements, unsupported files and duplicates", () => {
    const r = pickStatementRecords([
      st({ drive_file_id: "arch", status: "archived" }),
      st({ drive_file_id: "typ", document_type_name: "Tax Return" }),
      st({ drive_file_id: "img", file_name: "photo.png", mime_type: "image/png" }),
      st({ drive_file_id: "dup" }),
      st({ drive_file_id: "dup" }),
    ], 2025)
    expect(r.files.map((f) => f.id)).toEqual(["dup"])
  })
})
