/* eslint-disable no-restricted-syntax */
import { describe, it, expect, vi } from "vitest"
import { createPendingReferral } from "@/lib/operations/referral"
import type { SupabaseClient } from "@supabase/supabase-js"

function builder(result: unknown) {
  const b: Record<string, unknown> = {
    select: () => b,
    eq: () => b,
    insert: () => b,
    limit: () => b,
    maybeSingle: () => Promise.resolve(result),
    single: () => Promise.resolve(result),
    then: (res: (v: unknown) => void) => res(result),
  }
  return b
}

// Queue results in the order createPendingReferral queries:
// 1) contacts (referrer email)  2) referrals (dedup)  3) referrals (insert)
function supa(results: unknown[]) {
  let i = 0
  return {
    from: vi.fn(() => builder(results[i++] ?? { data: null, error: null })),
  } as unknown as SupabaseClient
}

const base = {
  referrerContactId: "ref-1",
  referredLeadId: "lead-1",
  referredName: "Referred Friend",
  referredEmail: "friend@example.com",
}

describe("createPendingReferral", () => {
  it("creates a pending referral on the happy path", async () => {
    const s = supa([
      { data: { email: "referrer@example.com" } }, // referrer (different email)
      { data: [] }, // dedup: none
      { data: { id: "r-123" } }, // insert
    ])
    const res = await createPendingReferral(base, s)
    expect(res).toEqual({ created: true, id: "r-123" })
  })

  it("blocks self-referral (referrer refers their own email)", async () => {
    const s = supa([{ data: { email: "FRIEND@example.com" } }]) // same as referredEmail (case-insensitive)
    const res = await createPendingReferral(base, s)
    expect(res).toEqual({ created: false, reason: "self_referral" })
  })

  it("blocks a duplicate referral for the same lead", async () => {
    const s = supa([
      { data: { email: "referrer@example.com" } },
      { data: [{ id: "existing" }] }, // dedup: already exists
    ])
    const res = await createPendingReferral(base, s)
    expect(res).toEqual({ created: false, reason: "duplicate" })
  })

  it("reports an error when the insert fails", async () => {
    const s = supa([
      { data: { email: "referrer@example.com" } },
      { data: [] },
      { data: null, error: { message: "boom" } },
    ])
    const res = await createPendingReferral(base, s)
    expect(res).toEqual({ created: false, reason: "error", detail: "boom" })
  })
})
