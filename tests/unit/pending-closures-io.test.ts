import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * getPendingClosures vs getPendingClosuresOrNull — a failed closure lookup must
 * read as "unknown" (null) to callers that can keep old behaviour (the services
 * page button), while getPendingClosures keeps returning [] for the home card.
 */
let sdResult: { data: unknown; error: { message: string } | null } = { data: [], error: null }
let throwOnFrom = false
const reported: string[] = []

vi.mock("@/lib/system-errors", () => ({
  reportSystemError: vi.fn(async (e: { message: string }) => { reported.push(e.message); return null }),
}))
vi.mock("@/lib/supabase-admin", () => {
  const chain = (table: string) => {
    const c: Record<string, unknown> = {}
    const self = () => c
    for (const m of ["select", "eq", "in", "is", "or"]) c[m] = self
    c.order = async () => (table === "service_deliveries" ? sdResult : { data: [], error: null })
    c.then = (res: (v: unknown) => void) => res(table === "account_contacts" ? { data: [], error: null } : { data: [], error: null })
    return c
  }
  return {
    supabaseAdmin: {
      from: (table: string) => {
        if (throwOnFrom) throw new Error("boom")
        return chain(table)
      },
    },
  }
})

import { getPendingClosures, getPendingClosuresOrNull } from "@/lib/portal/pending-closures"

describe("pending closures — unknown vs nothing owed", () => {
  beforeEach(() => { sdResult = { data: [], error: null }; throwOnFrom = false; reported.length = 0 })

  it("no active closures → [] from both", async () => {
    expect(await getPendingClosuresOrNull("c1")).toEqual([])
    expect(await getPendingClosures("c1")).toEqual([])
  })

  it("closure lookup error → OrNull gives null (unknown) and reports; plain variant gives []", async () => {
    sdResult = { data: null, error: { message: "db down" } }
    expect(await getPendingClosuresOrNull("c1")).toBeNull()
    expect(await getPendingClosures("c1")).toEqual([])
    expect(reported.some((m) => m.includes("db down"))).toBe(true)
  })

  it("one owed contact-only closure (no progress, no submissions) → returned by both", async () => {
    sdResult = { data: [{ id: "sd-1", account_id: null, created_at: "2026-06-01T00:00:00Z", source_closure_token: null }], error: null }
    const owed = await getPendingClosuresOrNull("c1")
    expect(owed).toEqual([{ serviceDeliveryId: "sd-1", accountId: null, companyName: null }])
    expect(await getPendingClosures("c1")).toEqual(owed)
  })

  it("unexpected throw → null, reported", async () => {
    throwOnFrom = true
    expect(await getPendingClosuresOrNull("c1")).toBeNull()
    expect(reported.some((m) => m.includes("boom"))).toBe(true)
  })
})
