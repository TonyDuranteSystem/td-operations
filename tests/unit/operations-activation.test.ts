/**
 * P3.3 — lib/operations/activation.ts unit tests.
 *
 * Tests the `activateService` shim: pre-check gating (not_found, not_ready,
 * already_activated), input validation, and result mapping from runActivation
 * (success, already-activated, error, thrown exception).
 *
 * Mocking strategy:
 *   - `supabaseAdmin.from("pending_activations").select().eq().single()` is
 *     stubbed via a simple `paFixture` object that resolves to {data, error}.
 *   - `runActivation` (from lib/operations/activate-service) is mocked directly
 *     since activation.ts now imports it instead of HTTP-fetching the route.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// ─── Fixture types ─────────────────────────────────────

interface PARow {
  id: string
  status: string
  activated_at: string | null
}

let paFixture: PARow | null = null
let paLookupError: { message: string } | null = null

vi.mock("@/lib/supabase-admin", () => {
  return {
    supabaseAdmin: {
      from: (_table: string) => {
        const chain = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn(() =>
            Promise.resolve({
              data: paFixture,
              error: paLookupError,
            }),
          ),
        }
        return chain
      },
    },
  }
})

vi.mock("@/lib/operations/activate-service", () => ({
  runActivation: vi.fn(),
}))

import { activateService } from "@/lib/operations/activation"
import { runActivation } from "@/lib/operations/activate-service"

// ─── Setup ──────────────────────────────────────────────

beforeEach(() => {
  paFixture = null
  paLookupError = null
  vi.mocked(runActivation).mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── Tests ──────────────────────────────────────────────

describe("activateService — input validation", () => {
  it("returns error when neither pending_activation_id nor offer_token is provided", async () => {
    const result = await activateService({})
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toMatch(/Must provide pending_activation_id or offer_token/)
  })

  // API_SECRET_TOKEN check removed — activation.ts no longer uses HTTP / Bearer
  // auth since it now calls runActivation directly (lib-to-lib, no secret needed).
})

describe("activateService — pre-check gating (by pending_activation_id)", () => {
  it("returns not_found when pending_activation does not exist", async () => {
    paFixture = null
    paLookupError = { message: "no rows" }

    const result = await activateService({ pending_activation_id: "missing" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("not_found")
    expect(result.error).toMatch(/No pending_activation with id "missing"/)
  })

  it("returns already_activated when activated_at is set (skips runActivation)", async () => {
    paFixture = {
      id: "pa-1",
      status: "activated",
      activated_at: "2026-04-15T00:00:00Z",
    }

    const result = await activateService({ pending_activation_id: "pa-1" })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("already_activated")
    expect(result.pending_activation_id).toBe("pa-1")
    expect(runActivation).not.toHaveBeenCalled()
  })

  it("returns not_ready when status is not payment_confirmed (skips runActivation)", async () => {
    paFixture = {
      id: "pa-1",
      status: "draft",
      activated_at: null,
    }

    const result = await activateService({ pending_activation_id: "pa-1" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("not_ready")
    expect(result.error).toMatch(/Status is "draft"/)
    expect(runActivation).not.toHaveBeenCalled()
  })
})

describe("activateService — pre-check gating (by offer_token)", () => {
  it("resolves offer_token to pending_activation_id and proceeds", async () => {
    paFixture = {
      id: "pa-99",
      status: "payment_confirmed",
      activated_at: null,
    }
    vi.mocked(runActivation).mockResolvedValue({
      ok: true,
      contract_type: "formation",
      mode: "auto",
      steps: [],
      service_deliveries: [],
      prepared_steps: 0,
    })

    const result = await activateService({ offer_token: "offer-xyz" })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("activated")
    expect(result.pending_activation_id).toBe("pa-99")
    expect(runActivation).toHaveBeenCalledOnce()
    expect(runActivation).toHaveBeenCalledWith("pa-99")
  })

  it("returns not_found when offer_token does not resolve", async () => {
    paFixture = null
    paLookupError = { message: "no rows" }

    const result = await activateService({ offer_token: "bogus" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("not_found")
    expect(result.error).toMatch(/No pending_activation for offer_token "bogus"/)
  })
})

describe("activateService — runActivation result handling", () => {
  beforeEach(() => {
    paFixture = { id: "pa-1", status: "payment_confirmed", activated_at: null }
  })

  it("maps ok:true result to outcome=activated with echoed data", async () => {
    vi.mocked(runActivation).mockResolvedValue({
      ok: true,
      contract_type: "onboarding",
      mode: "auto",
      steps: [{ step: "A", status: "done" }],
      service_deliveries: [{ id: "sd-1" }],
      prepared_steps: 3,
    })

    const result = await activateService({ pending_activation_id: "pa-1" })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("activated")
    expect(result.data?.contract_type).toBe("onboarding")
    expect(result.data?.mode).toBe("auto")
    expect(result.data?.prepared_steps).toBe(3)
    expect(result.data?.service_deliveries).toEqual([{ id: "sd-1" }])
  })

  it("maps 'Already activated' message to outcome=already_activated", async () => {
    vi.mocked(runActivation).mockResolvedValue({
      ok: true,
      message: "Already activated",
    })

    const result = await activateService({ pending_activation_id: "pa-1" })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("already_activated")
  })

  it("maps ok:false with status=400 to outcome=error with error message", async () => {
    vi.mocked(runActivation).mockResolvedValue({
      ok: false,
      status: 400,
      error: "Missing pending_activation_id",
    })

    const result = await activateService({ pending_activation_id: "pa-1" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toBe("Missing pending_activation_id")
  })

  it("maps ok:false with status=500 and no error to outcome=error with generic fallback", async () => {
    vi.mocked(runActivation).mockResolvedValue({
      ok: false,
      status: 500,
    })

    const result = await activateService({ pending_activation_id: "pa-1" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toBe("Activation failed (500)")
  })

  it("maps thrown exception in runActivation to outcome=error", async () => {
    vi.mocked(runActivation).mockRejectedValue(new Error("DB connection lost"))

    const result = await activateService({ pending_activation_id: "pa-1" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toBe("DB connection lost")
  })
})
