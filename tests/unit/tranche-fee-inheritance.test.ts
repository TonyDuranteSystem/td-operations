/**
 * resolveTrancheCardFeeRate — the ONE shared answer to "what card-fee rate does a later part of
 * a payment plan inherit", used by both the manual "Raise invoice" action and the auto-raise cron.
 * Extracted from invoice-actions.ts (2026-08-27, auto-raise build) so the two callers can never
 * silently diverge into two different rate-resolution chains — exactly the bug class bug-hunter
 * flagged as the likely outcome of a second, hand-rolled copy.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

let part1Row: { card_fee_rate?: number | null } | null = null
let offerRow: { card_fee_rate?: number | null } | null = null

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "payments") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                limit: () => ({ maybeSingle: () => Promise.resolve({ data: part1Row }) }),
              }),
            }),
          }),
        }
      }
      if (table === "offers") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: offerRow }) }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  },
}))

import { resolveTrancheCardFeeRate } from "@/lib/offers/payment-plan-state"

describe("resolveTrancheCardFeeRate", () => {
  beforeEach(() => {
    part1Row = null
    offerRow = null
  })

  it("inherits part 1's own stamped rate when it exists", async () => {
    part1Row = { card_fee_rate: 0 } // a waived deal — 0 is a real, meaningful rate, not "missing"
    offerRow = { card_fee_rate: 0.05 } // the live configured rate has since changed
    expect(await resolveTrancheCardFeeRate("offer-1")).toBe(0)
  })

  it("falls back to the offer's pinned rate when part 1 was never raised/charged", async () => {
    part1Row = null
    offerRow = { card_fee_rate: 0.05 }
    expect(await resolveTrancheCardFeeRate("offer-1")).toBe(0.05)
  })

  it("returns undefined when neither source has a rate (createTDInvoice stamps the live default)", async () => {
    part1Row = null
    offerRow = null
    expect(await resolveTrancheCardFeeRate("offer-1")).toBeUndefined()
  })

  it("treats a non-numeric part-1 rate as absent and falls through to the offer", async () => {
    part1Row = { card_fee_rate: null }
    offerRow = { card_fee_rate: 0.03 }
    expect(await resolveTrancheCardFeeRate("offer-1")).toBe(0.03)
  })
})
