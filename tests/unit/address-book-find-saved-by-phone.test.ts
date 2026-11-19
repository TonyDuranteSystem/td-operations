import { describe, expect, it, vi, beforeEach } from "vitest"

const calls: { overlaps?: [string, string[]]; archived?: boolean } = {}
let result: { data: unknown; error: { message: string } | null } = { data: [], error: null }

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => {
      const q: Record<string, unknown> = {}
      q.select = () => q
      q.is = (col: string) => { calls.archived = col === "archived_at"; return q }
      q.overlaps = (col: string, keys: string[]) => { calls.overlaps = [col, keys]; return q }
      q.limit = () => Promise.resolve(result)
      return q
    },
  },
}))
vi.mock("@/lib/catalog/framework", () => ({ getEntryById: vi.fn(), listEntries: vi.fn() }))

import { findSavedByPhone } from "@/lib/address-book/store"

describe("findSavedByPhone", () => {
  beforeEach(() => { calls.overlaps = undefined; calls.archived = undefined; result = { data: [], error: null } })

  it("looks the number up by its digits and last ten digits, ignoring archived people", async () => {
    result = { data: [{ id: "a1", full_name: "Vincenzo Randazzo", company: null }], error: null }
    const r = await findSavedByPhone("+393662406426")
    expect(r).toEqual([{ id: "a1", name: "Vincenzo Randazzo", company: null }])
    expect(calls.overlaps).toEqual(["phone_keys", ["393662406426", "3662406426"]])
    expect(calls.archived).toBe(true)
  })

  it("does not query for a number that is too short", async () => {
    expect(await findSavedByPhone("123")).toEqual([])
    expect(calls.overlaps).toBeUndefined()
  })

  it("throws when the read fails, so it never looks like 'not saved'", async () => {
    result = { data: null, error: { message: "boom" } }
    await expect(findSavedByPhone("+393662406426")).rejects.toThrow(/could not check saved people/)
  })
})
