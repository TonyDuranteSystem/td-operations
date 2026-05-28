/* eslint-disable no-restricted-syntax */
import { describe, it, expect, vi } from "vitest"
import { generateReferralCode, ensureReferralCode } from "@/lib/referral-utils"
import type { SupabaseClient } from "@supabase/supabase-js"

// Thenable, chainable Supabase stub: resolves to `result` at any await point
// (covers .single(), and awaiting .ilike()/.is() terminals directly).
function builder(result: unknown) {
  const b: Record<string, unknown> = {
    select: () => b,
    eq: () => b,
    ilike: () => b,
    update: () => b,
    is: () => b,
    single: () => Promise.resolve(result),
    then: (res: (v: unknown) => void) => res(result),
  }
  return b
}

function supaWithQueue(results: unknown[]) {
  let i = 0
  return {
    from: vi.fn(() => builder(results[i++] ?? { data: null, error: null })),
  } as unknown as SupabaseClient
}

describe("generateReferralCode", () => {
  it("produces first-last lowercase when no collision", async () => {
    const s = supaWithQueue([{ data: [] }])
    expect(await generateReferralCode("Marco Rossi", s)).toBe("marco-rossi")
  })

  it("joins middle/last names", async () => {
    const s = supaWithQueue([{ data: [] }])
    expect(await generateReferralCode("Maxence Van Beneden", s)).toBe("maxence-vanbeneden")
  })

  it("suffixes on collision", async () => {
    const s = supaWithQueue([{ data: [{ referral_code: "marco-rossi" }] }])
    expect(await generateReferralCode("Marco Rossi", s)).toBe("marco-rossi-2")
  })

  it("falls back to 'client' when the name has no Latin letters (edge: non-Latin)", async () => {
    const s = supaWithQueue([{ data: [] }])
    expect(await generateReferralCode("李", s)).toBe("client")
  })

  it("uses the single word when name has no separate last name", async () => {
    const s = supaWithQueue([{ data: [] }])
    expect(await generateReferralCode("Madonna", s)).toBe("madonna")
  })
})

describe("ensureReferralCode", () => {
  it("returns the existing code without generating", async () => {
    const s = supaWithQueue([
      { data: { referral_code: "marco-rossi", full_name: "Marco Rossi" } },
    ])
    expect(await ensureReferralCode("c1", s)).toBe("marco-rossi")
  })

  it("returns null when the contact has no usable name", async () => {
    const s = supaWithQueue([{ data: { referral_code: null, full_name: null } }])
    expect(await ensureReferralCode("c1", s)).toBeNull()
  })

  it("generates, persists, and returns a new code when missing", async () => {
    const s = supaWithQueue([
      { data: { referral_code: null, full_name: "Marco Rossi" } }, // fetch
      { data: [] }, // collision check inside generateReferralCode
      { error: null }, // update
    ])
    expect(await ensureReferralCode("c1", s)).toBe("marco-rossi")
  })
})
