import { describe, it, expect, vi, beforeEach } from "vitest"

/** resolveClosureSubmissionToken — reuse the token this person already saved for this closure. */
let result: { data: unknown; error: { message: string } | null } = { data: [], error: null }
const calls: Array<[string, unknown[]]> = []

const reported: string[] = []
vi.mock("@/lib/system-errors", () => ({
  reportSystemError: vi.fn(async (e: { message: string }) => { reported.push(e.message); return null }),
}))

vi.mock("@/lib/supabase-admin", () => {
  const chain: Record<string, unknown> = {}
  for (const m of ["from", "select", "like", "order", "limit", "eq", "is", "or"]) {
    chain[m] = (...args: unknown[]) => { calls.push([m, args]); return chain }
  }
  chain.then = (res: (v: unknown) => void) => res(result)
  return { supabaseAdmin: chain }
})

import { resolveClosureSubmissionToken } from "@/lib/portal/closure-submission-token"

const SD = "871acf5d-a077-4f4f-bbba-49bac75b2508"
const ACCT = "30c2cd96-03e4-43cf-9536-81d961b18b1d"

describe("resolveClosureSubmissionToken", () => {
  beforeEach(() => { result = { data: [], error: null }; calls.length = 0 })

  it("re-send after a name change → reuses this person's saved token", async () => {
    result = { data: [{ token: "portal-old-name-2026-871acf5d" }], error: null }
    const t = await resolveClosureSubmissionToken({ freshToken: "portal-new-name-2026-871acf5d", closureServiceDeliveryId: SD, contactId: "c1", accountId: ACCT })
    expect(t).toBe("portal-old-name-2026-871acf5d")
  })

  it("scopes to the same PERSON, and for a company closure also to their pre-company rows", async () => {
    await resolveClosureSubmissionToken({ freshToken: "f", closureServiceDeliveryId: SD, contactId: "c1", accountId: ACCT })
    expect(calls).toContainEqual(["eq", ["contact_id", "c1"]])
    expect(calls).toContainEqual(["or", [`account_id.eq.${ACCT},account_id.is.null`]])
    expect(calls).toContainEqual(["like", ["token", "portal-%-871acf5d"]])
  })

  it("a malformed account id is never interpolated into the filter", async () => {
    await resolveClosureSubmissionToken({ freshToken: "f", closureServiceDeliveryId: SD, contactId: "c1", accountId: "x,contact_id.neq.c1" })
    expect(calls.some(([m]) => m === "or")).toBe(false)
    expect(calls).toContainEqual(["is", ["account_id", null]])
  })

  it("first send / lookup error / no identity → fresh token", async () => {
    expect(await resolveClosureSubmissionToken({ freshToken: "fresh", closureServiceDeliveryId: SD, contactId: "c1", accountId: null })).toBe("fresh")
    result = { data: null, error: { message: "db down" } }
    expect(await resolveClosureSubmissionToken({ freshToken: "fresh", closureServiceDeliveryId: SD, contactId: "c1", accountId: null })).toBe("fresh")
    expect(reported.some((m) => m.includes("db down"))).toBe(true)
    expect(await resolveClosureSubmissionToken({ freshToken: "fresh", closureServiceDeliveryId: SD, contactId: null, accountId: null })).toBe("fresh")
  })
})
