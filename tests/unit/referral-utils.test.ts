/* eslint-disable no-restricted-syntax */
import { describe, it, expect, vi } from "vitest"
import { generateReferralCode, ensureReferralCode, calculateCommission } from "@/lib/referral-utils"
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

describe("calculateCommission", () => {
  // Regression for bug-hunter, 2026-08-14: `commissionPct || 10` silently overpaid a referrer
  // whose commission was deliberately set to a real 0% — the release route's caller
  // (resolveOfferCommission) already preserves an explicit 0 via `??`, so this function must too.
  it("pays exactly $0 on an explicit 0% credit_note commission — never the 10% default", () => {
    expect(calculateCommission("credit_note", 0, null, 3000, 3000)).toBe(0)
  })

  it("pays exactly $0 on an explicit 0% percentage commission", () => {
    expect(calculateCommission("percentage", 0, null, 3000, 3000)).toBe(0)
  })

  it("falls back to the 10% default only when the rate is genuinely unset (null)", () => {
    expect(calculateCommission("credit_note", null, null, 3000, 3000)).toBe(300)
  })

  it("applies a real positive rate normally", () => {
    expect(calculateCommission("percentage", 15, null, 2000, 2000)).toBe(300)
  })

  it("price_difference is unaffected by the nullish-vs-falsy fix", () => {
    expect(calculateCommission("price_difference", null, 5000, 3000, 4500)).toBe(500)
  })
})
