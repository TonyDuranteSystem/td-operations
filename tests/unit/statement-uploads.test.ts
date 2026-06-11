import { describe, it, expect } from "vitest"
import { analyzeDuplicates, sha256Hex, uploadSourceId, type ExistingRow } from "@/lib/tax/statement-uploads"

function row(ref: string, date: string, bank = "Mercury", source: string | null = "upload:aaa"): ExistingRow {
  return { transaction_ref: ref, transaction_date: date, bank_name: bank, source_file_id: source }
}

describe("sha256Hex / uploadSourceId", () => {
  it("is deterministic and namespaced", () => {
    const sha = sha256Hex(Buffer.from("hello"))
    expect(sha).toBe(sha256Hex(Buffer.from("hello")))
    expect(sha).toHaveLength(64)
    expect(uploadSourceId(sha)).toBe(`upload:${sha}`)
  })
})

describe("analyzeDuplicates", () => {
  it("clean upload → no alert", () => {
    const a = analyzeDuplicates(
      { sha256: "new", bankName: "Wise", refs: ["r1", "r2"], dates: ["2025-01-05", "2025-02-10"] },
      [row("x1", "2025-01-15")],
    )
    expect(a.identicalFile).toBe(false)
    expect(a.rowOverlap.count).toBe(0)
    expect(a.periodOverlap.months).toEqual([])
    expect(a.alert).toBeNull()
  })

  it("L1 — identical file already ingested", () => {
    const a = analyzeDuplicates(
      { sha256: "aaa", bankName: "Mercury", refs: ["r1"], dates: ["2025-01-05"] },
      [row("r1", "2025-01-05", "Mercury", "upload:aaa")],
    )
    expect(a.identicalFile).toBe(true)
    expect(a.alert).toContain("already uploaded this exact file")
  })

  it("L2 — partial row overlap with % and months", () => {
    const a = analyzeDuplicates(
      { sha256: "new", bankName: "Mercury", refs: ["r1", "r2", "r3", "r4"], dates: ["2025-03-01", "2025-03-15", "2025-04-01", "2025-04-20"] },
      [row("r1", "2025-03-01"), row("r2", "2025-03-15")],
    )
    expect(a.rowOverlap.count).toBe(2)
    expect(a.rowOverlap.pct).toBe(50)
    expect(a.rowOverlap.months).toEqual(["2025-03"])
    expect(a.alert).toContain("50%")
    expect(a.alert).toContain("excluded automatically")
  })

  it("L3 — same bank, same months, different rows (second account) → informational", () => {
    const a = analyzeDuplicates(
      { sha256: "new", bankName: "mercury", refs: ["n1", "n2"], dates: ["2025-05-02", "2025-06-09"] },
      [row("e1", "2025-05-20", "Mercury"), row("e2", "2025-07-01", "Mercury")],
    )
    expect(a.identicalFile).toBe(false)
    expect(a.rowOverlap.count).toBe(0)
    expect(a.periodOverlap.months).toEqual(["2025-05"])
    expect(a.alert).toContain("second account")
  })

  it("different bank, same months → no period alert", () => {
    const a = analyzeDuplicates(
      { sha256: "new", bankName: "Wise", refs: ["n1"], dates: ["2025-05-02"] },
      [row("e1", "2025-05-20", "Mercury")],
    )
    expect(a.alert).toBeNull()
  })

  it("empty file → no division by zero", () => {
    const a = analyzeDuplicates({ sha256: "new", bankName: "Wise", refs: [], dates: [] }, [])
    expect(a.rowOverlap.pct).toBe(0)
    expect(a.alert).toBeNull()
  })
})
