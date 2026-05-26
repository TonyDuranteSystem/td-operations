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

const YEAR = new Date().getFullYear()

describe("generateReferralCode", () => {
  it("produces LASTNAME-YEAR when no collision", async () => {
    const s = supaWithQueue([{ data: [] }])
    expect(await generateReferralCode("Marco Rossi", s)).toBe(`ROSSI-${YEAR}`)
  })

  it("suffixes on collision", async () => {
    const s = supaWithQueue([{ data: [{ referral_code: `ROSSI-${YEAR}` }] }])
    expect(await generateReferralCode("Marco Rossi", s)).toBe(`ROSSI-${YEAR}-2`)
  })

  it("falls back to CLIENT when the name has no Latin letters (edge: non-Latin)", async () => {
    const s = supaWithQueue([{ data: [] }])
    expect(await generateReferralCode("李", s)).toBe(`CLIENT-${YEAR}`)
  })

  it("uses the single word when name has no separate last name", async () => {
    const s = supaWithQueue([{ data: [] }])
    expect(await generateReferralCode("Madonna", s)).toBe(`MADONNA-${YEAR}`)
  })
})

describe("ensureReferralCode", () => {
  it("returns the existing code without generating", async () => {
    const s = supaWithQueue([
      { data: { referral_code: "ROSSI-2026", full_name: "Marco Rossi" } },
    ])
    expect(await ensureReferralCode("c1", s)).toBe("ROSSI-2026")
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
    expect(await ensureReferralCode("c1", s)).toBe(`ROSSI-${YEAR}`)
  })
})
