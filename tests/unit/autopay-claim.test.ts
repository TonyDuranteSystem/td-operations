/**
 * lib/operations/autopay-claim.ts unit tests
 *
 * Covers:
 *   - claim succeeds when unclaimed and unpaid
 *   - claim fails when already claimed and not expired (row-count check, not just "no error")
 *   - claim succeeds when a prior claim has expired
 *   - claim fails when status is already Paid, even if unclaimed
 *   - release clears the claim
 *   - recordCheckoutSessionId stores the session id
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

let updateResult: { data: Array<{ id: string }> | null; error: { message: string } | null }
let bareUpdateError: { message: string } | null = null
const calls: Array<{ payload: Record<string, unknown>; eq: Array<[string, unknown]>; neq: Array<[string, unknown]>; or: string[] }> = []
// Calls awaited WITHOUT a trailing .select() (release + recordCheckoutSessionId)
const bareUpdateCalls: Array<{ payload: Record<string, unknown>; eq: Array<[string, unknown]> }> = []

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => {
      const call: { payload: Record<string, unknown>; eq: Array<[string, unknown]>; neq: Array<[string, unknown]>; or: string[] } = {
        payload: {},
        eq: [],
        neq: [],
        or: [],
      }
      const chain = {
        update: vi.fn((payload: Record<string, unknown>) => {
          call.payload = payload
          return chain
        }),
        eq: vi.fn((col: string, value: unknown) => {
          call.eq.push([col, value])
          return chain
        }),
        neq: vi.fn((col: string, value: unknown) => {
          call.neq.push([col, value])
          return chain
        }),
        or: vi.fn((filter: string) => {
          call.or.push(filter)
          return chain
        }),
        select: vi.fn(() => {
          calls.push(call)
          return Promise.resolve(updateResult)
        }),
        // supabase-js query builders are themselves thenable — awaiting the
        // chain directly (no trailing .select()) resolves like a promise.
        then: (resolve: (v: { data: null; error: { message: string } | null }) => void) => {
          bareUpdateCalls.push({ payload: call.payload, eq: call.eq })
          resolve({ data: null, error: bareUpdateError })
        },
      }
      return chain
    },
  },
}))

import { claimPaymentForCharge, releasePaymentClaim, recordCheckoutSessionId } from "@/lib/operations/autopay-claim"

beforeEach(() => {
  updateResult = { data: null, error: null }
  bareUpdateError = null
  calls.length = 0
  bareUpdateCalls.length = 0
})

describe("claimPaymentForCharge", () => {
  it("returns true and claims when the update matches a row", async () => {
    updateResult = { data: [{ id: "p1" }], error: null }
    const claimed = await claimPaymentForCharge("p1", 60_000)
    expect(claimed).toBe(true)

    expect(calls[0].eq).toContainEqual(["id", "p1"])
    expect(calls[0].neq).toContainEqual(["status", "Paid"])
    expect(calls[0].or[0]).toMatch(/charge_claimed_until\.is\.null,charge_claimed_until\.lt\./)
    expect(calls[0].payload.charge_claimed_until).toBeTruthy()
  })

  it("returns false when no row matches (already claimed by the other caller)", async () => {
    updateResult = { data: [], error: null }
    const claimed = await claimPaymentForCharge("p1", 60_000)
    expect(claimed).toBe(false)
  })

  it("returns false on a Supabase error rather than throwing", async () => {
    updateResult = { data: null, error: { message: "connection reset" } }
    const claimed = await claimPaymentForCharge("p1", 60_000)
    expect(claimed).toBe(false)
  })

  it("treats a null data array as not claimed (defensive)", async () => {
    updateResult = { data: null, error: null }
    const claimed = await claimPaymentForCharge("p1", 60_000)
    expect(claimed).toBe(false)
  })
})

describe("releasePaymentClaim", () => {
  it("sets charge_claimed_until back to null for the given payment", async () => {
    await releasePaymentClaim("p1")
    expect(bareUpdateCalls).toHaveLength(1)
    expect(bareUpdateCalls[0].payload).toEqual({ charge_claimed_until: null })
    expect(bareUpdateCalls[0].eq).toContainEqual(["id", "p1"])
  })

  it("does not throw when the update errors", async () => {
    bareUpdateError = { message: "connection reset" }
    await expect(releasePaymentClaim("p1")).resolves.toBeUndefined()
  })
})

describe("recordCheckoutSessionId", () => {
  it("stores the Stripe Checkout Session id on the payment row", async () => {
    await recordCheckoutSessionId("p1", "cs_test_123")
    expect(bareUpdateCalls).toHaveLength(1)
    expect(bareUpdateCalls[0].payload).toEqual({ stripe_checkout_session_id: "cs_test_123" })
    expect(bareUpdateCalls[0].eq).toContainEqual(["id", "p1"])
  })

  it("does not throw when the update errors", async () => {
    bareUpdateError = { message: "connection reset" }
    await expect(recordCheckoutSessionId("p1", "cs_test_123")).resolves.toBeUndefined()
  })
})
