/**
 * P3.3 — lib/operations/activation.ts unit tests.
 *
 * Tests the `activateService` shim: pre-check gating (not_found, not_ready,
 * already_activated), input validation, and HTTP orchestration (success,
 * already-activated response, 4xx/5xx error mapping, transport failure).
 *
 * Mocking strategy:
 *   - `supabaseAdmin.from("pending_activations").select().eq().single()` is
 *     stubbed via a simple `paFixture` object that resolves to {data, error}.
 *   - `fetch` is stubbed globally via `vi.stubGlobal` so each test can control
 *     the response body + status.
 *   - `API_SECRET_TOKEN` and `NEXT_PUBLIC_APP_URL` are set on `process.env`
 *     before each test (unsetting is covered by a dedicated test).
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

import { activateService } from "@/lib/operations/activation"

// ─── Setup ──────────────────────────────────────────────

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  paFixture = null
  paLookupError = null
  process.env.API_SECRET_TOKEN = "test-secret"
  process.env.NEXT_PUBLIC_APP_URL = "https://test.example.com"
  vi.unstubAllGlobals()
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
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

  it("returns error when API_SECRET_TOKEN is not set", async () => {
    delete process.env.API_SECRET_TOKEN
    paFixture = { id: "pa-1", status: "payment_confirmed", activated_at: null }

    const result = await activateService({ pending_activation_id: "pa-1" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toMatch(/API_SECRET_TOKEN not configured/)
  })
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

  it("returns already_activated when activated_at is set (skips fetch)", async () => {
    paFixture = {
      id: "pa-1",
      status: "activated",
      activated_at: "2026-04-15T00:00:00Z",
    }
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const result = await activateService({ pending_activation_id: "pa-1" })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("already_activated")
    expect(result.pending_activation_id).toBe("pa-1")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("returns not_ready when status is not payment_confirmed (skips fetch)", async () => {
    paFixture = {
      id: "pa-1",
      status: "draft",
      activated_at: null,
    }
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const result = await activateService({ pending_activation_id: "pa-1" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("not_ready")
    expect(result.error).toMatch(/Status is "draft"/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("activateService — pre-check gating (by offer_token)", () => {
  it("resolves offer_token to pending_activation_id and proceeds", async () => {
    paFixture = {
      id: "pa-99",
      status: "payment_confirmed",
      activated_at: null,
    }
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          contract_type: "formation",
          mode: "auto",
          steps: [],
          service_deliveries: [],
          prepared_steps: 0,
        }),
    })
    vi.stubGlobal("fetch", fetchMock)

    const result = await activateService({ offer_token: "offer-xyz" })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("activated")
    expect(result.pending_activation_id).toBe("pa-99")
    expect(fetchMock).toHaveBeenCalledOnce()
    const call = fetchMock.mock.calls[0]
    expect(call[0]).toBe("https://test.example.com/api/workflows/activate-service")
    expect((call[1] as RequestInit).method).toBe("POST")
    expect((call[1] as RequestInit).body).toBe(
      JSON.stringify({ pending_activation_id: "pa-99" }),
    )
    const headers = (call[1] as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer test-secret")
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

describe("activateService — endpoint response handling", () => {
  beforeEach(() => {
    paFixture = { id: "pa-1", status: "payment_confirmed", activated_at: null }
  })

  it("maps 200 ok:true response to outcome=activated with echoed data", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          contract_type: "onboarding",
          mode: "auto",
          steps: [{ step: "A", status: "done" }],
          service_deliveries: [{ id: "sd-1" }],
          prepared_steps: 3,
        }),
    })
    vi.stubGlobal("fetch", fetchMock)

    const result = await activateService({ pending_activation_id: "pa-1" })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("activated")
    expect(result.data?.contract_type).toBe("onboarding")
    expect(result.data?.mode).toBe("auto")
    expect(result.data?.prepared_steps).toBe(3)
    expect(result.data?.service_deliveries).toEqual([{ id: "sd-1" }])
  })

  it("maps 200 'Already activated' message to outcome=already_activated", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ ok: true, message: "Already activated" }),
    })
    vi.stubGlobal("fetch", fetchMock)

    const result = await activateService({ pending_activation_id: "pa-1" })
    expect(result.success).toBe(true)
    expect(result.outcome).toBe("already_activated")
  })

  it("maps 4xx response to outcome=error with body.error message", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: "Missing pending_activation_id" }),
    })
    vi.stubGlobal("fetch", fetchMock)

    const result = await activateService({ pending_activation_id: "pa-1" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toBe("Missing pending_activation_id")
  })

  it("maps 500 response to outcome=error with generic fallback when body.error is missing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    })
    vi.stubGlobal("fetch", fetchMock)

    const result = await activateService({ pending_activation_id: "pa-1" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toBe("Activation failed (500)")
  })

  it("maps fetch transport failure to outcome=error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    vi.stubGlobal("fetch", fetchMock)

    const result = await activateService({ pending_activation_id: "pa-1" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toBe("ECONNREFUSED")
  })

  it("maps non-JSON response to outcome=error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error("invalid json")),
    })
    vi.stubGlobal("fetch", fetchMock)

    const result = await activateService({ pending_activation_id: "pa-1" })
    expect(result.success).toBe(false)
    expect(result.outcome).toBe("error")
    expect(result.error).toMatch(/Non-JSON response/)
  })
})
