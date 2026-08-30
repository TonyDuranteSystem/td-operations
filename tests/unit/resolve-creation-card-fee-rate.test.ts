/**
 * resolveCreationCardFeeRate (lib/payments/card-fee-config.ts) — dev job 10995181.
 *
 * The three-way answer to "what card-fee rate should a NEW invoice be
 * pinned at": an explicit caller-passed rate always wins; otherwise an
 * account enrolled in card autopay gets a waiver (0); otherwise the
 * globally configured rate. Composes isAccountAutopayEnabled
 * (lib/operations/card-autopay.ts) with the existing config reader —
 * this test covers the composition, not either half's own internals
 * (those have their own test files).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

let accountRow: { autopay_card_enabled: boolean } | null = null
let settingsRow: { value: Record<string, unknown> } | null = null

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "accounts") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: accountRow, error: null }),
            }),
          }),
        }
      }
      if (table === "app_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: settingsRow, error: null }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  },
}))

import { resolveCreationCardFeeRate, __resetCardFeeConfigCache } from "@/lib/payments/card-fee-config"

beforeEach(() => {
  accountRow = null
  settingsRow = null
  __resetCardFeeConfigCache()
})

describe("resolveCreationCardFeeRate", () => {
  it("an explicit rate always wins, even when the account is autopay-enabled", async () => {
    accountRow = { autopay_card_enabled: true }
    expect(await resolveCreationCardFeeRate(0.03, "acc-1")).toBe(0.03)
  })

  it("an explicit 0 (a waived offer) is honored, not treated as absent", async () => {
    accountRow = { autopay_card_enabled: false }
    expect(await resolveCreationCardFeeRate(0, "acc-1")).toBe(0)
  })

  it("waives the fee when no explicit rate is given and the account is enrolled", async () => {
    accountRow = { autopay_card_enabled: true }
    expect(await resolveCreationCardFeeRate(undefined, "acc-1")).toBe(0)
  })

  it("falls back to the configured rate when the account is not enrolled", async () => {
    accountRow = { autopay_card_enabled: false }
    settingsRow = { value: { card_rate: 0.04 } }
    expect(await resolveCreationCardFeeRate(undefined, "acc-1")).toBe(0.04)
  })

  it("falls back to the configured rate when there is no account at all (contact-only invoice)", async () => {
    settingsRow = { value: { card_rate: 0.04 } }
    expect(await resolveCreationCardFeeRate(undefined, undefined)).toBe(0.04)
  })

  it("falls back to the default rate when nothing is configured either", async () => {
    expect(await resolveCreationCardFeeRate(null, null)).toBe(0.05)
  })
})
