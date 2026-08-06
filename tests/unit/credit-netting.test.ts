/* eslint-disable no-restricted-syntax */
import { describe, it, expect, vi } from "vitest"
import { computeCreditApplication } from "@/lib/operations/credit-netting"
import type { SupabaseClient } from "@supabase/supabase-js"

// Thenable chainable builder; the credit query ends on .order() which is awaited.
function supaWithCredits(rows: Array<{ id: string; credit_remaining: number }>) {
  const b: Record<string, unknown> = {
    select: () => b, eq: () => b, gt: () => b, is: () => b,
    order: () => Promise.resolve({ data: rows }),
    then: (res: (v: unknown) => void) => res({ data: rows }),
  }
  return { from: vi.fn(() => b) } as unknown as SupabaseClient
}

const P = (accountId = "a1", amount = 1000, currency = "USD") => ({ accountId, amount, currency })

describe("computeCreditApplication", () => {
  it("returns nothing for a zero/negative invoice", async () => {
    const s = supaWithCredits([{ id: "c1", credit_remaining: 500 }])
    expect(await computeCreditApplication(P("a1", 0), s)).toEqual({ appliedTotal: 0, credits: [] })
  })

  it("returns nothing when there are no outstanding credits", async () => {
    const s = supaWithCredits([])
    expect(await computeCreditApplication(P(), s)).toEqual({ appliedTotal: 0, credits: [] })
  })

  it("applies a credit smaller than the invoice in full", async () => {
    const s = supaWithCredits([{ id: "c1", credit_remaining: 250 }])
    const r = await computeCreditApplication(P("a1", 1000), s)
    expect(r.appliedTotal).toBe(250)
    expect(r.credits).toEqual([{ id: "c1", applyAmount: 250 }])
  })

  it("caps at the invoice amount when the credit is larger (carryover)", async () => {
    const s = supaWithCredits([{ id: "c1", credit_remaining: 1500 }])
    const r = await computeCreditApplication(P("a1", 1000), s)
    expect(r.appliedTotal).toBe(1000)
    expect(r.credits).toEqual([{ id: "c1", applyAmount: 1000 }])
  })

  it("applies multiple credits oldest-first until the invoice is covered", async () => {
    const s = supaWithCredits([
      { id: "c1", credit_remaining: 600 },
      { id: "c2", credit_remaining: 600 },
    ])
    const r = await computeCreditApplication(P("a1", 1000), s)
    expect(r.appliedTotal).toBe(1000)
    expect(r.credits).toEqual([
      { id: "c1", applyAmount: 600 },
      { id: "c2", applyAmount: 400 },
    ])
  })
})
