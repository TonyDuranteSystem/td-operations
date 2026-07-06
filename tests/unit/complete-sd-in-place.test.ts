/**
 * completeSDInPlace — lib/operations/service-delivery.ts
 *
 * The ITIN-finalize completion path: flips an SD to completed WITHOUT a stage
 * change (terminal stages not named "Completed" never complete via
 * advanceServiceDelivery). Verifies the status guard, the TOCTOU-guarded
 * update, and the stage_history append.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}))

// ─── Mock harness ──────────────────────────────────────

let sdRow: Record<string, unknown> | null = null
let sdReadError: { message: string } | null = null
let updateCapture: Record<string, unknown> | null = null
let updateFilters: Array<[string, unknown]> = []
let updateResponseRows: Array<{ id: string }> = []

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== "service_deliveries") throw new Error(`unexpected table: ${table}`)
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn(() => Promise.resolve({ data: sdRow, error: sdReadError })),
        update: (patch: Record<string, unknown>) => {
          updateCapture = patch
          const chain = {
            eq: (col: string, val: unknown) => {
              updateFilters.push([col, val])
              return chain
            },
            select: () => Promise.resolve({ data: updateResponseRows, error: null }),
          }
          return chain
        },
      }
    },
  },
}))

// dbWrite passthrough — same contract as lib/db.ts (throws on error, returns data).
vi.mock("@/lib/db", () => ({
  dbWrite: async <T,>(q: PromiseLike<{ data: T; error: { message: string } | null }>) => {
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data
  },
  dbWriteSafe: async <T,>(q: PromiseLike<{ data: T; error: unknown }>) => q,
}))

vi.mock("@/lib/services", () => ({
  getEntryByServiceType: vi.fn(() => Promise.resolve(null)),
}))

import { completeSDInPlace } from "@/lib/operations/service-delivery"

beforeEach(() => {
  sdRow = null
  sdReadError = null
  updateCapture = null
  updateFilters = []
  updateResponseRows = [{ id: "sd-1" }]
})

describe("completeSDInPlace", () => {
  it("completes an active SD: status flip, end_date, TOCTOU guard, history append", async () => {
    sdRow = {
      id: "sd-1",
      status: "active",
      stage: "ITIN Approved",
      stage_order: 8,
      stage_history: [{ to_stage: "IRS Processing" }],
    }

    const res = await completeSDInPlace("sd-1", { actor: "itin-finalize", notes: "letter processed" })

    expect(res.completed).toBe(true)
    expect(updateCapture?.status).toBe("completed")
    expect(updateCapture?.end_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // TOCTOU: the update must be guarded on id AND status='active'
    expect(updateFilters).toContainEqual(["id", "sd-1"])
    expect(updateFilters).toContainEqual(["status", "active"])
    // History: prior entries preserved, new entry appended in place (no stage change)
    const history = updateCapture?.stage_history as Array<Record<string, unknown>>
    expect(history).toHaveLength(2)
    expect(history[1]).toMatchObject({
      from_stage: "ITIN Approved",
      to_stage: "ITIN Approved",
      advanced_by: "itin-finalize",
      notes: "letter processed",
    })
  })

  it("returns completed:false without writing when the SD is already completed", async () => {
    sdRow = { id: "sd-1", status: "completed", stage: "ITIN Approved", stage_order: 8, stage_history: [] }

    const res = await completeSDInPlace("sd-1")

    expect(res.completed).toBe(false)
    expect(updateCapture).toBeNull()
  })

  it("returns completed:false when the guarded update matches no row (concurrent completion)", async () => {
    sdRow = { id: "sd-1", status: "active", stage: "ITIN Approved", stage_order: 8, stage_history: [] }
    updateResponseRows = []

    const res = await completeSDInPlace("sd-1")

    expect(res.completed).toBe(false)
  })

  it("throws when the SD does not exist", async () => {
    sdRow = null
    sdReadError = { message: "0 rows" }

    await expect(completeSDInPlace("missing")).rejects.toThrow(/not found/)
  })

  it("starts a fresh history array when stage_history is null", async () => {
    sdRow = { id: "sd-1", status: "active", stage: "ITIN Approved", stage_order: 8, stage_history: null }

    const res = await completeSDInPlace("sd-1")

    expect(res.completed).toBe(true)
    const history = updateCapture?.stage_history as Array<Record<string, unknown>>
    expect(history).toHaveLength(1)
  })
})
