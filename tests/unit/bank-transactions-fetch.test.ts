import { describe, it, expect } from "vitest"
import { fetchAllPaged } from "@/lib/bank-transactions-fetch"

/** Build a fake page-fetcher over a fixed array, recording the ranges asked. */
function pager(total: number) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i }))
  const calls: Array<[number, number]> = []
  const fetchPage = async (from: number, to: number) => {
    calls.push([from, to])
    return rows.slice(from, to + 1)
  }
  return { rows, calls, fetchPage }
}

describe("fetchAllPaged", () => {
  it("reads everything across multiple pages (the >1000 cap case)", async () => {
    const { rows, fetchPage } = pager(1992)
    const out = await fetchAllPaged(fetchPage, 1000)
    expect(out).toHaveLength(1992)
    expect(out.map(r => r.id)).toEqual(rows.map(r => r.id))
  })

  it("stops after the first short page", async () => {
    const { calls, fetchPage } = pager(1992)
    await fetchAllPaged(fetchPage, 1000)
    // 0-999, 1000-1999 (returns 992 < 1000 → stop). No third call.
    expect(calls).toEqual([[0, 999], [1000, 1999]])
  })

  it("an exact multiple of pageSize triggers one final empty fetch (and is correct)", async () => {
    const { calls, fetchPage } = pager(2000)
    const out = await fetchAllPaged(fetchPage, 1000)
    expect(out).toHaveLength(2000)
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })

  it("handles a single short page", async () => {
    const { fetchPage } = pager(7)
    const out = await fetchAllPaged(fetchPage, 1000)
    expect(out).toHaveLength(7)
  })

  it("handles an empty result set", async () => {
    const { calls, fetchPage } = pager(0)
    const out = await fetchAllPaged(fetchPage, 1000)
    expect(out).toEqual([])
    expect(calls).toEqual([[0, 999]])
  })

  it("rejects a non-positive pageSize", async () => {
    await expect(fetchAllPaged(async () => [], 0)).rejects.toThrow(/pageSize/)
  })

  it("propagates an error from the page fetcher", async () => {
    await expect(
      fetchAllPaged(async () => { throw new Error("Failed to load transactions: boom") }),
    ).rejects.toThrow(/Failed to load transactions/)
  })
})
