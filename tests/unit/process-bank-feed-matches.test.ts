/**
 * PR B — processBankFeedMatches unit tests.
 *
 * Covers the orchestrator behavior:
 *   - empty feedIds → all-zeros result
 *   - exact match + linked pending_activation in awaiting_payment →
 *     runActivation is called, counter auto_activated++
 *   - exact match + NO linked pending_activation → still auto_activated
 *     (the matcher already paid the invoice; manual TD wire case)
 *   - high-confidence match with threshold='exact' (default behavior of
 *     matchAndReconcile) → matched=false + paymentId set → needs_review++
 *   - runActivation throws → status='activation_crashed', counter
 *     activation_crashed++
 *   - matchAndReconcile throws → pushed to errors, loop continues
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// ─── Mocks ─────────────────────────────────────────────

vi.mock("@/lib/bank-feed-matcher", () => ({
  matchAndReconcile: vi.fn(),
}))

vi.mock("@/lib/operations/activate-service", () => ({
  runActivation: vi.fn(),
}))

// supabaseAdmin chain mock. pending_activations lookup is fixture-driven.
// td_bank_feeds.update() calls are recorded for assertion.

let pendingActivationFixture: { id: string; status: string } | null = null
const updateRecorder: Array<{ table: string; payload: Record<string, unknown>; eqArg: string | null }> = []

vi.mock("@/lib/supabase-admin", () => {
  return {
    supabaseAdmin: {
      from: (table: string) => {
        if (table === "pending_activations") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn(() =>
              Promise.resolve({ data: pendingActivationFixture, error: null }),
            ),
          }
        }
        if (table === "td_bank_feeds") {
          let lastPayload: Record<string, unknown> = {}
          const chain: Record<string, unknown> = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn(() => Promise.resolve({ data: [], error: null })),
            // `updateFeed` now READS the row before writing `review_metadata`, so it can merge
            // rather than replace it (a wholesale replace destroyed the multi-invoice
            // allocation record, the refund flag, and the "a human said no" memory).
            maybeSingle: vi.fn(() => Promise.resolve({ data: { review_metadata: null }, error: null })),
            update: vi.fn((payload: Record<string, unknown>) => {
              lastPayload = payload
              return {
                eq: vi.fn((_col: string, val: string) => {
                  updateRecorder.push({ table, payload: lastPayload, eqArg: val })
                  return Promise.resolve({ data: null, error: null })
                }),
              }
            }),
          }
          return chain
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
        }
      },
    },
  }
})

vi.mock("@/lib/settings", () => ({
  getAppSetting: vi.fn(async (_key: string, fallback: unknown) => fallback),
}))

import { processBankFeedMatches } from "@/lib/operations/process-bank-feed-matches"
import { matchAndReconcile } from "@/lib/bank-feed-matcher"
import { runActivation } from "@/lib/operations/activate-service"

const matchMock = vi.mocked(matchAndReconcile)
const actMock = vi.mocked(runActivation)

// ─── Setup ─────────────────────────────────────────────

beforeEach(() => {
  pendingActivationFixture = null
  updateRecorder.length = 0
  matchMock.mockReset()
  actMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── Tests ─────────────────────────────────────────────

describe("processBankFeedMatches", () => {
  it("returns all-zero counts when no feedIds provided and DB returns no rows", async () => {
    const result = await processBankFeedMatches({})
    expect(result.processed).toBe(0)
    expect(result.auto_activated).toBe(0)
    expect(result.needs_review).toBe(0)
    expect(result.activation_crashed).toBe(0)
    expect(result.no_match).toBe(0)
    expect(result.errors).toEqual([])
    expect(matchMock).not.toHaveBeenCalled()
  })

  it("counts auto_activated when exact match + linked pending_activation succeeds", async () => {
    matchMock.mockResolvedValueOnce({
      matched: true,
      paymentId: "pay-1",
      invoiceNumber: "INV-001",
      confidence: "exact",
    })
    pendingActivationFixture = { id: "pa-1", status: "awaiting_payment" }
    actMock.mockResolvedValueOnce({ ok: true })

    const result = await processBankFeedMatches({ feedIds: ["feed-1"] })

    expect(matchMock).toHaveBeenCalledWith("feed-1")
    expect(actMock).toHaveBeenCalledWith("pa-1")
    expect(result.processed).toBe(1)
    expect(result.auto_activated).toBe(1)
    expect(result.needs_review).toBe(0)
    expect(result.activation_crashed).toBe(0)
    expect(result.errors).toEqual([])
    // No td_bank_feeds.update on the success path — the matcher already set
    // status='matched'.
    expect(updateRecorder.find(u => u.table === "td_bank_feeds")).toBeUndefined()
  })

  it("counts auto_activated when exact match has NO linked pending_activation (manual TD wire case)", async () => {
    matchMock.mockResolvedValueOnce({
      matched: true,
      paymentId: "pay-2",
      invoiceNumber: "INV-002",
      confidence: "exact",
    })
    pendingActivationFixture = null

    const result = await processBankFeedMatches({ feedIds: ["feed-2"] })

    expect(actMock).not.toHaveBeenCalled()
    expect(result.auto_activated).toBe(1)
    expect(result.processed).toBe(1)
  })

  it("counts needs_review when matchAndReconcile returns matched=false + paymentId (high w/ exact threshold)", async () => {
    // matchAndReconcile already wrote status='needs_review' to td_bank_feeds
    // — the orchestrator just counts based on the result envelope.
    matchMock.mockResolvedValueOnce({
      matched: false,
      paymentId: "pay-3",
      invoiceNumber: "INV-003",
      confidence: "high",
    })

    const result = await processBankFeedMatches({ feedIds: ["feed-3"] })

    expect(actMock).not.toHaveBeenCalled()
    expect(result.needs_review).toBe(1)
    expect(result.auto_activated).toBe(0)
    expect(result.no_match).toBe(0)
  })

  it("counts no_match when matchAndReconcile returns matched=false with no paymentId", async () => {
    matchMock.mockResolvedValueOnce({ matched: false })

    const result = await processBankFeedMatches({ feedIds: ["feed-4"] })

    expect(result.no_match).toBe(1)
    expect(result.needs_review).toBe(0)
    expect(result.auto_activated).toBe(0)
  })

  it("parks feed at activation_crashed when runActivation throws", async () => {
    matchMock.mockResolvedValueOnce({
      matched: true,
      paymentId: "pay-5",
      invoiceNumber: "INV-005",
      confidence: "exact",
    })
    pendingActivationFixture = { id: "pa-5", status: "payment_confirmed" }
    actMock.mockRejectedValueOnce(new Error("activate boom"))

    const result = await processBankFeedMatches({ feedIds: ["feed-5"] })

    expect(result.activation_crashed).toBe(1)
    expect(result.auto_activated).toBe(0)
    const update = updateRecorder.find(u => u.table === "td_bank_feeds" && u.eqArg === "feed-5")
    expect(update).toBeDefined()
    expect(update?.payload.status).toBe("activation_crashed")
    expect((update?.payload.review_metadata as Record<string, unknown>).activation_error).toBe("activate boom")
    expect((update?.payload.review_metadata as Record<string, unknown>).pending_activation_id).toBe("pa-5")
  })

  it("parks feed at activation_crashed when runActivation returns ok=false", async () => {
    matchMock.mockResolvedValueOnce({
      matched: true,
      paymentId: "pay-6",
      invoiceNumber: "INV-006",
      confidence: "exact",
    })
    pendingActivationFixture = { id: "pa-6", status: "payment_confirmed" }
    actMock.mockResolvedValueOnce({ ok: false, error: "validation failed" })

    const result = await processBankFeedMatches({ feedIds: ["feed-6"] })

    expect(result.activation_crashed).toBe(1)
    const update = updateRecorder.find(u => u.table === "td_bank_feeds" && u.eqArg === "feed-6")
    expect(update?.payload.status).toBe("activation_crashed")
    expect((update?.payload.review_metadata as Record<string, unknown>).activation_error).toBe("validation failed")
  })

  it("pushes matchAndReconcile errors to the errors array and continues the loop", async () => {
    matchMock
      .mockRejectedValueOnce(new Error("matcher exploded"))
      .mockResolvedValueOnce({ matched: false })

    const result = await processBankFeedMatches({ feedIds: ["feed-a", "feed-b"] })

    expect(result.processed).toBe(2)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toEqual({ feedId: "feed-a", error: "matcher exploded" })
    expect(result.no_match).toBe(1)
  })
})
