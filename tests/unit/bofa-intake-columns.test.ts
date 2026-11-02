import { describe, it, expect } from "vitest"
import { LIST_COLUMNS, REVIEW_COLUMNS, readWithReviewColumns } from "@/lib/bofa-intake/columns"

describe("readWithReviewColumns (a database that has not had the review step yet)", () => {
  it("reads the full list when the columns exist", async () => {
    const asked: string[] = []
    const r = await readWithReviewColumns<string[]>(LIST_COLUMNS, async (cols) => { asked.push(cols); return { data: ["row"], error: null } })
    expect(r.reviewReady).toBe(true)
    expect(asked).toEqual([`${LIST_COLUMNS}, ${REVIEW_COLUMNS}`])
  })

  it("falls back to the long-standing columns when the database refuses the new ones, and says so", async () => {
    const asked: string[] = []
    const r = await readWithReviewColumns<string[]>(LIST_COLUMNS, async (cols) => {
      asked.push(cols)
      return cols.includes("reviewed_at") ? { data: null, error: { message: 'column "reviewed_at" does not exist' } } : { data: ["row"], error: null }
    })
    expect(r.reviewReady).toBe(false)
    expect(r.data).toEqual(["row"])
    expect(asked).toEqual([`${LIST_COLUMNS}, ${REVIEW_COLUMNS}`, LIST_COLUMNS])
  })

  it("a real failure on both reads is still an error (never an empty 'all clear')", async () => {
    const r = await readWithReviewColumns<string[]>(LIST_COLUMNS, async () => ({ data: null, error: { message: "db down" } }))
    expect(r.error?.message).toBe("db down")
    expect(r.data).toBeNull()
  })

  it("the long-standing list never names a review column", () => {
    for (const col of REVIEW_COLUMNS.split(",").map((c) => c.trim())) expect(LIST_COLUMNS).not.toContain(col)
  })
})
