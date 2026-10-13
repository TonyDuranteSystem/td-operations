import { describe, it, expect } from "vitest"
import { isExcludedCompany, TEST_COMPANY_IDS } from "@/lib/crm-store/go-live"
import { walkBatch } from "@/lib/crm-store/go-live-batch"

describe("who never switches", () => {
  it("only Active companies switch; the test company never does", () => {
    expect(isExcludedCompany({ id: "x", status: "Active" })).toBe(false)
    for (const s of ["Closed", "Cancelled", "Suspended", "Offboarding", "Pending Formation", null]) expect(isExcludedCompany({ id: "x", status: s })).toBe(true)
    expect(isExcludedCompany({ id: Array.from(TEST_COMPANY_IDS)[0], status: "Active" })).toBe(true)
    expect(isExcludedCompany({ id: "y", status: "Active", name: " Uxio Test LLC " })).toBe(true)
  })
})

describe("night batch walk", () => {
  const cands = ["A", "B", "C", "D"].map((n) => ({ accountId: n, companyName: n }))
  const ok = (id: string) => ({ ok: true, runId: id, message: "ok", report: {} as never, repointed: 3, problems: [] })
  it("a failed or throwing company is skipped and listed, the rest still switch", async () => {
    const r = await walkBatch("u", { limit: 10, budgetMs: 1e9 }, {
      candidates: async () => cands,
      runOne: async (id) => { if (id === "B") return { ...ok(id), ok: false, message: "check failed" }; if (id === "C") throw new Error("boom"); return ok(id) },
      now: () => 0,
    })
    expect(r.switched).toBe(2)
    expect(r.skipped.map((s) => s.accountId)).toEqual(["B", "C"])
    expect(r.skipped[1].message).toBe("boom")
    expect(r.remaining).toBe(0)
  })
  it("stops at the group size and reports how many are left", async () => {
    const r = await walkBatch("u", { limit: 2, budgetMs: 1e9 }, { candidates: async () => cands, runOne: async (id) => ok(id), now: () => 0 })
    expect(r.attempted).toBe(2)
    expect(r.remaining).toBe(2)
  })
  it("stops starting new companies when the time budget is spent", async () => {
    let t = 0
    const r = await walkBatch("u", { limit: 10, budgetMs: 100 }, { candidates: async () => cands, runOne: async (id) => { t += 60; return ok(id) }, now: () => t })
    expect(r.attempted).toBe(2)
    expect(r.remaining).toBe(2)
  })
})
