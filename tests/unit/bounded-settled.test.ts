import { describe, it, expect } from "vitest"
import { allSettledBounded } from "@/lib/inbox/bounded-settled"

describe("allSettledBounded", () => {
  it("matches Promise.allSettled's shape and ORDER", async () => {
    const items = [1, 2, 3, 4, 5]
    const fn = async (n: number) => {
      if (n % 2 === 0) throw new Error(`boom ${n}`)
      return n * 10
    }
    const bounded = await allSettledBounded(items, 2, fn)
    const native = await Promise.allSettled(items.map(fn))

    expect(bounded.map((r) => r.status)).toEqual(native.map((r) => r.status))
    expect(bounded.map((r) => (r.status === "fulfilled" ? r.value : null)))
      .toEqual([10, null, 30, null, 50])
    expect(bounded[1].status === "rejected" && (bounded[1].reason as Error).message).toBe("boom 2")
  })

  it("never exceeds the concurrency ceiling", async () => {
    const items = Array.from({ length: 50 }, (_, i) => i)
    let inFlight = 0
    let peak = 0
    await allSettledBounded(items, 12, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
    })
    expect(peak).toBeLessThanOrEqual(12)
    expect(peak).toBeGreaterThan(1) // actually parallel, not serialized
  })

  it("processes every item exactly once", async () => {
    const items = Array.from({ length: 37 }, (_, i) => i)
    const seen: number[] = []
    const res = await allSettledBounded(items, 5, async (n) => { seen.push(n); return n })
    expect(res).toHaveLength(37)
    expect(new Set(seen).size).toBe(37)
    expect(res.every((r) => r.status === "fulfilled")).toBe(true)
  })

  it("never throws even if every call rejects", async () => {
    const res = await allSettledBounded([1, 2, 3], 2, async () => { throw new Error("x") })
    expect(res.every((r) => r.status === "rejected")).toBe(true)
  })

  it("handles an empty list and clamps a bad concurrency", async () => {
    expect(await allSettledBounded([], 5, async () => 1)).toEqual([])
    const res = await allSettledBounded([1, 2], 0, async (n) => n)
    expect(res.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual([1, 2])
  })
})
