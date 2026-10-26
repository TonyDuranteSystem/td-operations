import { describe, it, expect, vi } from "vitest"
import { releaseSlotClaim } from "@/lib/storage-app/slot-lease"

function fakeClient(result: { error: unknown } | "throw") {
  const calls: { table?: string; patch?: unknown; eq?: unknown[]; is?: unknown[] } = {}
  const chain = {
    eq: vi.fn((...a: unknown[]) => { calls.eq = a; return chain }),
    is: vi.fn((...a: unknown[]) => { calls.is = a; return result === "throw" ? Promise.reject(new Error("boom")) : Promise.resolve(result) }),
  }
  const client = { from: vi.fn((t: string) => { calls.table = t; return { update: vi.fn((p: unknown) => { calls.patch = p; return chain }) } }) }
  return { client, calls }
}

describe("releaseSlotClaim", () => {
  it("clears the lease of a still-open slot only", async () => {
    const { client, calls } = fakeClient({ error: null })
    expect(await releaseSlotClaim(client, "intent-1")).toBe(true)
    expect(calls.table).toBe("store_upload_intents")
    expect(calls.patch).toEqual({ claimed_at: null, lease_until: null })
    expect(calls.eq).toEqual(["id", "intent-1"])
    expect(calls.is).toEqual(["consumed_at", null])
  })
  it("reports false, never throws, when the database call fails", async () => {
    expect(await releaseSlotClaim(fakeClient({ error: { message: "x" } }).client, "i")).toBe(false)
    expect(await releaseSlotClaim(fakeClient("throw").client, "i")).toBe(false)
  })
})
