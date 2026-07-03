import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Job } from "@/lib/jobs/queue"

const recatMock = vi.fn(async (..._a: unknown[]) => ({
  scanned: 5, recategorized: 2, transferPairs: 0, aiCategorized: 3, aiErrors: [], uncategorizedRemaining: 0,
  aiStats: { batchesSent: 1, batchesFailed: 0, suggestionsParsed: 3, truncatedBatches: 0, capped: false },
}))
vi.mock("@/lib/tax/categorization-engine", () => ({
  recategorizeAccountYear: (...a: unknown[]) => recatMock(...a),
}))

import { handleRecategorizeAi } from "@/lib/jobs/handlers/recategorize-ai"

const job = (payload: Record<string, unknown>): Job => ({ id: "j1", payload } as unknown as Job)

beforeEach(() => recatMock.mockClear())

describe("handleRecategorizeAi", () => {
  it("runs the AWAITED AI pass and reports it", async () => {
    const r = await handleRecategorizeAi(job({ account_id: "acc-1", tax_year: 2025 }))
    expect(recatMock).toHaveBeenCalledTimes(1)
    expect(recatMock.mock.calls[0]).toEqual(["acc-1", 2025, { aiAssist: true }])
    expect(r.ok).not.toBe(false)
    expect(r.steps.some(s => s.name === "ai_categorize" && s.status === "ok")).toBe(true)
  })

  it("rejects an invalid payload without calling the engine", async () => {
    const r = await handleRecategorizeAi(job({ account_id: "", tax_year: 2025 }))
    expect(recatMock).not.toHaveBeenCalled()
    expect(r.ok).toBe(false)
    expect(r.steps[0].status).toBe("error")
  })

  it("rejects a non-integer tax_year", async () => {
    const r = await handleRecategorizeAi(job({ account_id: "acc-1", tax_year: "2025" as unknown as number }))
    expect(recatMock).not.toHaveBeenCalled()
    expect(r.ok).toBe(false)
  })
})
