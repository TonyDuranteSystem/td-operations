import { describe, it, expect, vi, beforeEach } from "vitest"

const rpc = vi.fn()
const inFn = vi.fn()
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { rpc: (...a: unknown[]) => rpc(...a), from: () => ({ select: () => ({ in: (...a: unknown[]) => inFn(...a) }) }) } }))

import { defaultCombineLookup } from "@/lib/crm-store/merge-combine"

describe("defaultCombineLookup (reads the plan; fails closed)", () => {
  beforeEach(() => { rpc.mockReset(); inFn.mockReset() })
  it("returns the database's plan", async () => {
    rpc.mockResolvedValue({ data: { combined: true, files_moved: 2 }, error: null })
    expect(await defaultCombineLookup("l", "w")).toEqual({ combined: true, files_moved: 2 })
    expect(rpc).toHaveBeenCalledWith("store_combine_plan", { p_loser_contact: "l", p_winner_contact: "w" })
  })
  it("a database error is an error, never 'nothing to combine'", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } })
    expect(await defaultCombineLookup("l", "w")).toEqual({ error: "boom" })
  })
  it("a database without the combine function keeps the old rule: both storages -> refused", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "Could not find the function public.store_combine_plan in the schema cache" } })
    inFn.mockResolvedValue({ data: [{ contact_id: "l" }, { contact_id: "w" }], error: null })
    const r = await defaultCombineLookup("l", "w")
    expect("blocker" in r && r.blocker).toMatch(/cannot combine two storages yet/)
  })
  it("...and one storage or none -> nothing to combine", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "function store_combine_plan does not exist" } })
    inFn.mockResolvedValue({ data: [{ contact_id: "l" }], error: null })
    expect(await defaultCombineLookup("l", "w")).toEqual({ combined: false })
  })
})
