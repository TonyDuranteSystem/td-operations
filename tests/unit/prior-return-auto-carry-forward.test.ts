import { describe, it, expect } from "vitest"
import {
  rankFiledReturnCandidates,
  locateAndExtractOurFiledReturn,
  type FiledReturnDoc,
  type PriorReturnRecord,
  type PriorReturnExtraction,
} from "@/lib/tax/prior-return-extract"
import { validatedExtraction, type PriorReturnCaseRecord } from "@/lib/tax/prior-return-case"

const extraction = (over: Partial<PriorReturnExtraction> = {}): PriorReturnExtraction => ({
  form_type: "1065",
  tax_year: 2024,
  ein: "35-2811085",
  schedule_l: { beginning: { cash: 100, total_assets: 100, total_liabilities: 0, capital: 100 }, ending: { cash: 5000, total_assets: 5000, total_liabilities: 0, capital: 5000 } },
  m2: { beginning_capital: 100, ending_capital: 5000 },
  k1s: [{ partner_name: "Sofia Marinoni", ownership_pct: 50, ending_capital: 2500 }],
  ...over,
})

const buf = Buffer.from("pdf")

describe("rankFiledReturnCandidates", () => {
  const docs: FiledReturnDoc[] = [
    { drive_file_id: "a", file_name: "Form 1120 2023 - X.pdf", document_type_name: "Form 1120", created_at: "2025-01-01" },
    { drive_file_id: "b", file_name: "Form 1065 2024 - X.pdf", document_type_name: "Form 1065", created_at: "2026-04-01" },
    { drive_file_id: "c", file_name: "Form 1120 2024 - X.pdf", document_type_name: "Form 1120", created_at: "2026-04-01" },
    { drive_file_id: "b", file_name: "Form 1065 2024 - X (dupe).pdf", document_type_name: "Form 1065", created_at: "2026-04-09" },
  ]

  it("dedupes by drive_file_id", () => {
    const ranked = rankFiledReturnCandidates(docs, 2024)
    expect(ranked.filter(d => d.drive_file_id === "b")).toHaveLength(1)
  })

  it("prefers the year-matching docs, then 1065 over 1120", () => {
    const ranked = rankFiledReturnCandidates(docs, 2024)
    expect(ranked[0].drive_file_id).toBe("b") // 2024 + 1065
    expect(ranked[1].drive_file_id).toBe("c") // 2024 + 1120
    expect(ranked[2].drive_file_id).toBe("a") // 2023
  })

  it("ignores rows without a drive_file_id", () => {
    const ranked = rankFiledReturnCandidates([{ drive_file_id: "", file_name: "x", document_type_name: "Form 1065", created_at: "2026-01-01" }], 2024)
    expect(ranked).toHaveLength(0)
  })
})

describe("locateAndExtractOurFiledReturn", () => {
  const docs: FiledReturnDoc[] = [
    { drive_file_id: "good", file_name: "Form 1065 2024 - X.pdf", document_type_name: "Form 1065", created_at: "2026-04-01" },
    { drive_file_id: "bad", file_name: "Form 1120 2024 - X.pdf", document_type_name: "Form 1120", created_at: "2026-03-01" },
  ]
  const validated: PriorReturnRecord = { status: "validated", extracted: extraction(), issues: [], source: "drive:good", extracted_at: "2026-06-22T00:00:00Z" }
  const quarantined: PriorReturnRecord = { status: "quarantined", extracted: extraction(), issues: [{ code: "WRONG_YEAR", message: "x" }], source: "drive:bad", extracted_at: "2026-06-22T00:00:00Z" }

  it("returns null when no filed-return docs exist", async () => {
    const r = await locateAndExtractOurFiledReturn("acct", 2024, null, { fetchCandidates: async () => [] })
    expect(r).toBeNull()
  })

  it("returns the first validated extraction and stops there", async () => {
    let calls = 0
    const r = await locateAndExtractOurFiledReturn("acct", 2024, null, {
      fetchCandidates: async () => docs,
      downloadImpl: async () => ({ buffer: buf }),
      extractImpl: async () => { calls++; return validated },
    })
    expect(r?.status).toBe("validated")
    expect(calls).toBe(1) // stopped at the first
  })

  it("falls back to a quarantined record when nothing validates", async () => {
    const r = await locateAndExtractOurFiledReturn("acct", 2024, null, {
      fetchCandidates: async () => docs,
      downloadImpl: async () => ({ buffer: buf }),
      extractImpl: async () => quarantined,
    })
    expect(r?.status).toBe("quarantined")
  })

  it("returns null when every candidate fails to extract (→ caller keeps staff tie-out)", async () => {
    const r = await locateAndExtractOurFiledReturn("acct", 2024, null, {
      fetchCandidates: async () => docs,
      downloadImpl: async () => ({ buffer: buf }),
      extractImpl: async () => ({ status: "failed", error: "unreadable" }),
    })
    expect(r).toBeNull()
  })

  it("skips a download error and still uses a later validated candidate", async () => {
    const r = await locateAndExtractOurFiledReturn("acct", 2024, null, {
      fetchCandidates: async () => docs,
      downloadImpl: async (id) => { if (id === "good") throw new Error("drive 404"); return { buffer: buf } },
      extractImpl: async () => validated,
    })
    expect(r?.status).toBe("validated")
  })

  it("never throws when listing the documents fails", async () => {
    const r = await locateAndExtractOurFiledReturn("acct", 2024, null, { fetchCandidates: async () => { throw new Error("db down") } })
    expect(r).toBeNull()
  })
})

describe("validatedExtraction (both prior-return sources read identically)", () => {
  const ext = extraction()
  it("reads a validated client upload (filed_elsewhere)", () => {
    const rec: PriorReturnCaseRecord = { case: "filed_elsewhere", status: "validated", extracted: ext, issues: [], source: "upload:x", extracted_at: "z" }
    expect(validatedExtraction(rec)).toBe(ext)
  })
  it("reads OUR validated filed return (we_filed)", () => {
    const rec: PriorReturnCaseRecord = { case: "we_filed", status: "validated", tax_return_id: "tr1", note: "n", recorded_at: "z", extracted: ext, issues: [], source: "drive:good" }
    expect(validatedExtraction(rec)).toBe(ext)
  })
  it("returns null for we_filed on_file / quarantined / claim_mismatch", () => {
    expect(validatedExtraction({ case: "we_filed", status: "on_file", tax_return_id: "t", note: "", recorded_at: "z" })).toBeNull()
    expect(validatedExtraction({ case: "we_filed", status: "claim_mismatch", tax_return_id: null, note: "", recorded_at: "z" })).toBeNull()
    expect(validatedExtraction({ case: "we_filed", status: "quarantined", tax_return_id: "t", note: "", recorded_at: "z", extracted: ext, issues: [], source: "drive:bad" })).toBeNull()
  })
  it("returns null for first_year / never_filed / null", () => {
    expect(validatedExtraction({ case: "first_year", status: "first_year", formation_date: "2024-03-01", note: "", recorded_at: "z" })).toBeNull()
    expect(validatedExtraction(null)).toBeNull()
  })
})
