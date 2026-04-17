/**
 * P3.5 — lib/exceptions/queries.ts unit tests
 *
 * Covers: the pure age-filter logic (awaiting_payment only surfaces when
 * older than 48h; payment_confirmed always surfaces) and the
 * getExceptionsSnapshot aggregate.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

// ─── Mock state — one per table ──────────────────────────

let pendingActivations: Array<Record<string, unknown>> = []
let devTasks: Array<Record<string, unknown>> = []
let jobQueue: Array<Record<string, unknown>> = []
let emailQueue: Array<Record<string, unknown>> = []
let webhookEvents: Array<Record<string, unknown>> = []

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        in: vi.fn(() => chain),
        is: vi.fn(() => chain),
        ilike: vi.fn(() => chain),
        order: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        then: (resolve: (v: unknown) => void) => {
          let rows: Array<Record<string, unknown>> = []
          if (table === "pending_activations") rows = pendingActivations
          if (table === "dev_tasks") rows = devTasks
          if (table === "job_queue") rows = jobQueue
          if (table === "email_queue") rows = emailQueue
          if (table === "webhook_events") rows = webhookEvents
          resolve({ data: rows, error: null })
        },
      })
      return chain
    },
  },
}))

beforeEach(() => {
  pendingActivations = []
  devTasks = []
  jobQueue = []
  emailQueue = []
  webhookEvents = []
})

// ─── Partial activations age filter ──────────────────────

describe("getPartialActivations — age filter", () => {
  it("always surfaces payment_confirmed regardless of age", async () => {
    pendingActivations = [
      {
        id: "pa-1",
        client_name: "Alice",
        client_email: "a@x.com",
        offer_token: "alice-2026",
        amount: 1000,
        currency: "EUR",
        payment_method: "Stripe",
        status: "payment_confirmed",
        signed_at: new Date().toISOString(),
        payment_confirmed_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      },
    ]
    const { getPartialActivations } = await import("@/lib/exceptions/queries")
    const rows = await getPartialActivations()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe("payment_confirmed")
  })

  it("filters out fresh awaiting_payment (<48h)", async () => {
    const recent = new Date(Date.now() - 12 * 3600 * 1000).toISOString()
    pendingActivations = [
      {
        id: "pa-2",
        client_name: "Bob",
        client_email: "b@x.com",
        offer_token: "bob-2026",
        amount: 1000,
        currency: "USD",
        payment_method: "Wire",
        status: "awaiting_payment",
        signed_at: recent,
        payment_confirmed_at: null,
        created_at: recent,
      },
    ]
    const { getPartialActivations } = await import("@/lib/exceptions/queries")
    const rows = await getPartialActivations()
    expect(rows).toHaveLength(0)
  })

  it("surfaces stale awaiting_payment (>48h)", async () => {
    const stale = new Date(Date.now() - 72 * 3600 * 1000).toISOString()
    pendingActivations = [
      {
        id: "pa-3",
        client_name: "Carol",
        client_email: "c@x.com",
        offer_token: "carol-2026",
        amount: 2000,
        currency: "EUR",
        payment_method: "Stripe",
        status: "awaiting_payment",
        signed_at: stale,
        payment_confirmed_at: null,
        created_at: stale,
      },
    ]
    const { getPartialActivations } = await import("@/lib/exceptions/queries")
    const rows = await getPartialActivations()
    expect(rows).toHaveLength(1)
    expect(rows[0].age_hours).toBeGreaterThanOrEqual(48)
  })
})

// ─── Audit findings shape ────────────────────────────────

describe("getAuditFindings — progress_log parsing", () => {
  it("pulls the latest action + result from progress_log", async () => {
    devTasks = [
      {
        id: "dt-1",
        title: "[AUTO] Audit Health Check: 1 P0 issue(s) found",
        priority: "high",
        created_at: new Date().toISOString(),
        progress_log: [
          { date: "2026-04-17", action: "invalid_status", result: "3 rows" },
          { date: "2026-04-17", action: "orphan_sd", result: "5 rows" },
        ],
      },
    ]
    const { getAuditFindings } = await import("@/lib/exceptions/queries")
    const rows = await getAuditFindings()
    expect(rows).toHaveLength(1)
    expect(rows[0].latest_action).toBe("orphan_sd")
    expect(rows[0].latest_result).toBe("5 rows")
  })

  it("handles null progress_log gracefully", async () => {
    devTasks = [
      {
        id: "dt-2",
        title: "[AUTO] Some check",
        priority: "high",
        created_at: new Date().toISOString(),
        progress_log: null,
      },
    ]
    const { getAuditFindings } = await import("@/lib/exceptions/queries")
    const rows = await getAuditFindings()
    expect(rows[0].latest_action).toBeNull()
    expect(rows[0].latest_result).toBeNull()
  })
})

// ─── Aggregate snapshot ──────────────────────────────────

describe("getExceptionsSnapshot — aggregate", () => {
  it("sums total count across all sources", async () => {
    pendingActivations = [
      {
        id: "pa-1",
        client_name: "Alice",
        client_email: "a@x.com",
        offer_token: "alice-2026",
        amount: 1000,
        currency: "EUR",
        payment_method: "Stripe",
        status: "payment_confirmed",
        signed_at: new Date().toISOString(),
        payment_confirmed_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      },
    ]
    devTasks = [
      { id: "dt-1", title: "[AUTO] x", priority: "high", created_at: new Date().toISOString(), progress_log: [] },
      { id: "dt-2", title: "[AUTO] y", priority: "low", created_at: new Date().toISOString(), progress_log: [] },
    ]
    jobQueue = [
      { id: "j-1", job_type: "formation-setup", status: "failed", attempts: 3, max_attempts: 3, error: "boom", created_at: new Date().toISOString(), account_id: "acct-1" },
    ]
    emailQueue = []
    webhookEvents = [
      { id: "w-1", source: "stripe", event_type: "payment_intent.succeeded", external_id: "pi_123", review_status: "failed", created_at: new Date().toISOString() },
    ]

    const { getExceptionsSnapshot } = await import("@/lib/exceptions/queries")
    const snap = await getExceptionsSnapshot()
    expect(snap.totalCount).toBe(5)
    expect(snap.partialActivations).toHaveLength(1)
    expect(snap.auditFindings).toHaveLength(2)
    expect(snap.failedJobs).toHaveLength(1)
    expect(snap.failedEmails).toHaveLength(0)
    expect(snap.webhookReviews).toHaveLength(1)
  })

  it("returns 0 total when system is clean", async () => {
    const { getExceptionsSnapshot } = await import("@/lib/exceptions/queries")
    const snap = await getExceptionsSnapshot()
    expect(snap.totalCount).toBe(0)
  })
})
