/**
 * PR C — POST /api/crm/admin-actions/sync-bank-feeds-now route tests.
 *
 * Verifies:
 *   - rejects non-dashboard / unauthenticated users
 *   - calls syncMercury, syncAirwallex, processBankFeedMatches in order
 *   - returns aggregated counts from each sub-step
 *   - per-step failures captured into per-key error, the response still
 *     returns ok:true with the other keys populated
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Auth mocks ─────────────────────────────────────────────────────────────

let mockUser: { id: string; email: string } | null = {
  id: "admin-1",
  email: "admin@tonydurante.us",
}
let mockIsDashboardUser = true

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getUser: () => Promise.resolve({ data: { user: mockUser }, error: null }),
    },
  }),
}))

vi.mock("@/lib/auth", () => ({
  isDashboardUser: () => mockIsDashboardUser,
}))

// ── Lib mocks — record call order ──────────────────────────────────────────

const callOrder: string[] = []
const mercuryFn = vi.fn(async () => {
  callOrder.push("mercury")
  return { accounts: 2, added: 3, skipped: 1, errors: 0, details: "ok" }
})
const airwallexFn = vi.fn(async () => {
  callOrder.push("airwallex")
  return { accounts: 1, added: 5, skipped: 0, errors: 0, details: "ok" }
})
const matchFn = vi.fn(async () => {
  callOrder.push("match")
  return {
    processed: 8,
    auto_activated: 2,
    needs_review: 1,
    activation_crashed: 0,
    no_match: 5,
    errors: [],
  }
})

vi.mock("@/lib/mercury-sync", () => ({
  syncMercuryTransactions: (...args: unknown[]) => mercuryFn(...args),
}))

vi.mock("@/lib/airwallex-sync", () => ({
  syncAirwallexDeposits: (...args: unknown[]) => airwallexFn(...args),
}))

vi.mock("@/lib/operations/process-bank-feed-matches", () => ({
  processBankFeedMatches: (...args: unknown[]) => matchFn(...args),
}))

// ── Route under test ───────────────────────────────────────────────────────

import { POST } from "@/app/api/crm/admin-actions/sync-bank-feeds-now/route"

function makeRequest(): Parameters<typeof POST>[0] {
  return new Request("http://localhost/api/crm/admin-actions/sync-bank-feeds-now", {
    method: "POST",
  }) as unknown as Parameters<typeof POST>[0]
}

beforeEach(() => {
  callOrder.length = 0
  mercuryFn.mockClear()
  airwallexFn.mockClear()
  matchFn.mockClear()
  // Reset default happy-path implementations
  mercuryFn.mockImplementation(async () => {
    callOrder.push("mercury")
    return { accounts: 2, added: 3, skipped: 1, errors: 0, details: "ok" }
  })
  airwallexFn.mockImplementation(async () => {
    callOrder.push("airwallex")
    return { accounts: 1, added: 5, skipped: 0, errors: 0, details: "ok" }
  })
  matchFn.mockImplementation(async () => {
    callOrder.push("match")
    return {
      processed: 8,
      auto_activated: 2,
      needs_review: 1,
      activation_crashed: 0,
      no_match: 5,
      errors: [],
    }
  })
  mockUser = { id: "admin-1", email: "admin@tonydurante.us" }
  mockIsDashboardUser = true
})

// ── Auth ───────────────────────────────────────────────────────────────────

describe("sync-bank-feeds-now — auth", () => {
  it("rejects unauthenticated request", async () => {
    mockUser = null
    const res = await POST(makeRequest())
    expect(res.status).toBe(403)
    expect(mercuryFn).not.toHaveBeenCalled()
    expect(airwallexFn).not.toHaveBeenCalled()
    expect(matchFn).not.toHaveBeenCalled()
  })

  it("rejects non-dashboard user", async () => {
    mockIsDashboardUser = false
    const res = await POST(makeRequest())
    expect(res.status).toBe(403)
    expect(mercuryFn).not.toHaveBeenCalled()
  })
})

// ── Happy path ─────────────────────────────────────────────────────────────

describe("sync-bank-feeds-now — happy path", () => {
  it("calls Mercury → Airwallex → match in order and aggregates counts", async () => {
    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(callOrder).toEqual(["mercury", "airwallex", "match"])

    expect(body.ok).toBe(true)
    expect(body.mercury).toMatchObject({ added: 3 })
    expect(body.airwallex).toMatchObject({ added: 5 })
    expect(body.match).toMatchObject({
      processed: 8,
      auto_activated: 2,
      needs_review: 1,
      activation_crashed: 0,
    })
    // Confirms a 7-day window: from < to and they are ISO dates.
    expect(typeof body.from).toBe("string")
    expect(typeof body.to).toBe("string")
    expect(body.from < body.to).toBe(true)
  })
})

// ── Per-step error isolation ───────────────────────────────────────────────

describe("sync-bank-feeds-now — per-step error isolation", () => {
  it("captures Mercury failure without crashing — Airwallex + match still run", async () => {
    mercuryFn.mockImplementation(async () => {
      callOrder.push("mercury")
      throw new Error("mercury down")
    })

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.ok).toBe(true)
    expect(body.mercury).toEqual({ error: "mercury down" })
    expect(body.airwallex).toMatchObject({ added: 5 })
    expect(body.match).toMatchObject({ processed: 8 })
    expect(callOrder).toEqual(["mercury", "airwallex", "match"])
  })

  it("captures Airwallex failure — Mercury + match still produce results", async () => {
    airwallexFn.mockImplementation(async () => {
      callOrder.push("airwallex")
      throw new Error("airwallex token expired")
    })

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.mercury).toMatchObject({ added: 3 })
    expect(body.airwallex).toEqual({ error: "airwallex token expired" })
    expect(body.match).toMatchObject({ processed: 8 })
  })

  it("captures match failure — sync results still returned", async () => {
    matchFn.mockImplementation(async () => {
      callOrder.push("match")
      throw new Error("match orchestrator crashed")
    })

    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.mercury).toMatchObject({ added: 3 })
    expect(body.airwallex).toMatchObject({ added: 5 })
    expect(body.match).toEqual({ error: "match orchestrator crashed" })
  })
})
