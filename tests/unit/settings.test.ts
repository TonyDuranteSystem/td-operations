/**
 * lib/settings.ts — getRenewalBannerMinYear
 *
 * Covers the year-gate helper that controls whether the portal renewal-MSA
 * banner renders. Default 2027 (hides 2026 banner during legacy-payment
 * purgatory). Antonio bumps higher in Dev Tools to extend the hide.
 *
 * The helper reads from app_settings via getAppSetting; this test mocks
 * the underlying supabase client and exercises the cast + fallback logic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

let mockValue: unknown = null
let mockError: { message: string } | null = null

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: mockValue !== null ? { value: mockValue } : null,
              error: mockError,
            }),
        }),
      }),
    }),
  },
}))

import { getRenewalBannerMinYear } from "@/lib/settings"

beforeEach(() => {
  mockValue = null
  mockError = null
})

describe("getRenewalBannerMinYear", () => {
  it("returns 2027 default when no row exists", async () => {
    mockValue = null
    expect(await getRenewalBannerMinYear()).toBe(2027)
  })

  it("returns the configured numeric value when set", async () => {
    mockValue = 2028
    expect(await getRenewalBannerMinYear()).toBe(2028)
  })

  it("coerces stringified numbers (jsonb may round-trip as string)", async () => {
    mockValue = "2030"
    expect(await getRenewalBannerMinYear()).toBe(2030)
  })

  it("falls back to 2027 on non-numeric values rather than crashing", async () => {
    mockValue = "not-a-year"
    expect(await getRenewalBannerMinYear()).toBe(2027)
  })

  it("falls back to 2027 on negative or zero values", async () => {
    mockValue = -1
    expect(await getRenewalBannerMinYear()).toBe(2027)
    mockValue = 0
    expect(await getRenewalBannerMinYear()).toBe(2027)
  })

  it("returns 2027 when supabase errors out (treats as missing)", async () => {
    mockError = { message: "connection refused" }
    expect(await getRenewalBannerMinYear()).toBe(2027)
  })
})
