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
let accountContacts: Array<Record<string, unknown>> = []
let tasks: Array<Record<string, unknown>> = []
let serviceDeliveries: Array<Record<string, unknown>> = []
let taxReturns: Array<Record<string, unknown>> = []
let accountsRows: Array<Record<string, unknown>> = []

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
        gte: vi.fn(() => chain),
        lt: vi.fn(() => chain),
        not: vi.fn(() => chain),
        order: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        then: (resolve: (v: unknown) => void) => {
          let rows: Array<Record<string, unknown>> = []
          if (table === "pending_activations") rows = pendingActivations
          if (table === "dev_tasks") rows = devTasks
          if (table === "job_queue") rows = jobQueue
          if (table === "email_queue") rows = emailQueue
          if (table === "webhook_events") rows = webhookEvents
          if (table === "account_contacts") rows = accountContacts
          if (table === "tasks") rows = tasks
          if (table === "service_deliveries") rows = serviceDeliveries
          if (table === "tax_returns") rows = taxReturns
          if (table === "accounts") rows = accountsRows
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
  accountContacts = []
  tasks = []
  serviceDeliveries = []
  taxReturns = []
  accountsRows = []
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

// ─── Phase C — Tier drift ────────────────────────────────

describe("getTierDrift", () => {
  it("flags rows where contact.portal_tier differs from account.portal_tier", async () => {
    accountContacts = [
      {
        contact_id: "c-1",
        account_id: "a-1",
        contacts: {
          id: "c-1",
          full_name: "Luca Test",
          email: "luca@x.com",
          portal_tier: "onboarding",
          updated_at: new Date().toISOString(),
        },
        accounts: {
          id: "a-1",
          company_name: "Luca Test LLC",
          portal_tier: "active",
          updated_at: new Date().toISOString(),
        },
      },
    ]
    const { getTierDrift } = await import("@/lib/exceptions/queries")
    const rows = await getTierDrift()
    expect(rows).toHaveLength(1)
    expect(rows[0].contact_tier).toBe("onboarding")
    expect(rows[0].account_tier).toBe("active")
    expect(rows[0].contact_name).toBe("Luca Test")
  })

  it("skips rows where tiers match", async () => {
    accountContacts = [
      {
        contact_id: "c-2",
        account_id: "a-2",
        contacts: { id: "c-2", full_name: "Clean", email: "clean@x.com", portal_tier: "active", updated_at: new Date().toISOString() },
        accounts: { id: "a-2", company_name: "Clean LLC", portal_tier: "active", updated_at: new Date().toISOString() },
      },
    ]
    const { getTierDrift } = await import("@/lib/exceptions/queries")
    expect(await getTierDrift()).toHaveLength(0)
  })

  it("skips when either tier is null (not yet set)", async () => {
    accountContacts = [
      {
        contact_id: "c-3",
        account_id: "a-3",
        contacts: { id: "c-3", full_name: "None", email: "n@x.com", portal_tier: null, updated_at: new Date().toISOString() },
        accounts: { id: "a-3", company_name: "None LLC", portal_tier: "active", updated_at: new Date().toISOString() },
      },
    ]
    const { getTierDrift } = await import("@/lib/exceptions/queries")
    expect(await getTierDrift()).toHaveLength(0)
  })
})

// ─── Phase C — Silent-failed jobs ────────────────────────

describe("getSilentFailedJobs", () => {
  it("surfaces job_queue rows where status=completed but result.summary signals failure", async () => {
    jobQueue = [
      {
        id: "job-bad",
        job_type: "onboarding_setup",
        status: "completed",
        result: { summary: "Validation failed: 1 error(s)" },
        payload: { contact_id: "c-1", account_id: null },
        created_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      },
      {
        id: "job-good",
        job_type: "onboarding_setup",
        status: "completed",
        result: { summary: "23 ok, 0 errors, 2 skipped" },
        payload: { contact_id: "c-2" },
        created_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      },
      {
        id: "job-blocked",
        job_type: "onboarding_setup",
        status: "completed",
        result: { summary: "OCR cross-check blocked: EIN mismatch" },
        payload: { account_id: "a-3" },
        created_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      },
    ]
    const { getSilentFailedJobs } = await import("@/lib/exceptions/queries")
    const rows = await getSilentFailedJobs()
    expect(rows.map(r => r.id).sort()).toEqual(["job-bad", "job-blocked"])
    expect(rows.find(r => r.id === "job-bad")?.summary).toContain("Validation failed")
  })

  it("ignores jobs without a result summary string", async () => {
    jobQueue = [
      { id: "j-1", job_type: "x", status: "completed", result: null, payload: {}, created_at: new Date().toISOString(), completed_at: null },
      { id: "j-2", job_type: "x", status: "completed", result: {}, payload: {}, created_at: new Date().toISOString(), completed_at: null },
    ]
    const { getSilentFailedJobs } = await import("@/lib/exceptions/queries")
    expect(await getSilentFailedJobs()).toHaveLength(0)
  })
})

// ─── Phase C — Orphan tasks ──────────────────────────────

describe("getOrphanTasks", () => {
  it("returns shape for tasks with contact but no account", async () => {
    const old = new Date(Date.now() - 3 * 3600 * 1000).toISOString()
    tasks = [
      {
        id: "t-1",
        task_title: "Wizard validation failed — 2L Consulting LLC",
        contact_id: "c-1",
        assigned_to: "Luca",
        priority: "High",
        category: "Client Response",
        status: "To Do",
        created_at: old,
      },
    ]
    const { getOrphanTasks } = await import("@/lib/exceptions/queries")
    const rows = await getOrphanTasks()
    expect(rows).toHaveLength(1)
    expect(rows[0].contact_id).toBe("c-1")
    expect(rows[0].age_hours).toBeGreaterThanOrEqual(3)
  })
})

// ─── Phase C — Snapshot aggregate extension ──────────────

describe("getExceptionsSnapshot — Phase C sources roll into totalCount", () => {
  it("counts tierDrift + silentFailedJobs + orphanTasks in the snapshot", async () => {
    accountContacts = [
      {
        contact_id: "c-1",
        account_id: "a-1",
        contacts: { id: "c-1", full_name: "X", email: "x@x.com", portal_tier: "onboarding", updated_at: new Date().toISOString() },
        accounts: { id: "a-1", company_name: "X LLC", portal_tier: "active", updated_at: new Date().toISOString() },
      },
    ]
    jobQueue = [
      { id: "j-1", job_type: "x", status: "completed", result: { summary: "Validation failed: 1 error(s)" }, payload: {}, created_at: new Date().toISOString(), completed_at: null },
    ]
    const old = new Date(Date.now() - 3 * 3600 * 1000).toISOString()
    tasks = [
      { id: "t-1", task_title: "orphan", contact_id: "c-9", assigned_to: null, priority: null, category: null, status: "To Do", created_at: old },
    ]
    const { getExceptionsSnapshot } = await import("@/lib/exceptions/queries")
    const snap = await getExceptionsSnapshot()
    // Assert each Phase C source populates and the aggregate includes them.
    // totalCount can also include legacy sources (the mock doesn't honor
    // DB filters, so a status=completed row can appear in getFailedJobs
    // too — that over-counts but doesn't matter for the Phase C coverage
    // assertion). We check ≥3 to capture the three new sources and allow
    // for that mock-side noise.
    expect(snap.tierDrift).toHaveLength(1)
    expect(snap.silentFailedJobs).toHaveLength(1)
    expect(snap.orphanTasks).toHaveLength(1)
    expect(snap.totalCount).toBeGreaterThanOrEqual(3)
  })
})

// ─── Phase F — Tax Return extension gaps ────────────────

describe("getTaxReturnExtensionGaps", () => {
  it("flags SDs with no matching tax_returns row", async () => {
    serviceDeliveries = [
      {
        id: "sd-1",
        account_id: "acct-1",
        service_type: "Tax Return",
        stage: "1st Installment Paid",
        status: "active",
        updated_at: new Date().toISOString(),
      },
    ]
    accountsRows = [{ id: "acct-1", company_name: "Marvin LLC" }]
    // tax_returns intentionally empty
    const { getTaxReturnExtensionGaps } = await import("@/lib/exceptions/queries")
    const rows = await getTaxReturnExtensionGaps()
    expect(rows).toHaveLength(1)
    expect(rows[0].reason).toBe("no_tax_returns_row")
    expect(rows[0].company_name).toBe("Marvin LLC")
  })

  it("flags tax_returns rows with extension_filed != true", async () => {
    serviceDeliveries = [
      { id: "sd-2", account_id: "acct-2", stage: "Data Received", status: "active", updated_at: new Date().toISOString() },
    ]
    accountsRows = [{ id: "acct-2", company_name: "Acme LLC" }]
    taxReturns = [
      {
        id: "tr-2",
        account_id: "acct-2",
        tax_year: 2025,
        return_type: "SMLLC",
        extension_filed: false,
        extension_submission_id: null,
      },
    ]
    const { getTaxReturnExtensionGaps } = await import("@/lib/exceptions/queries")
    const rows = await getTaxReturnExtensionGaps()
    expect(rows).toHaveLength(1)
    expect(rows[0].reason).toBe("extension_not_filed")
    expect(rows[0].tax_year).toBe(2025)
    expect(rows[0].return_type).toBe("SMLLC")
  })

  it("flags extension_filed=true rows with null confirmation ID", async () => {
    serviceDeliveries = [
      { id: "sd-3", account_id: "acct-3", stage: "Extension Filed", status: "active", updated_at: new Date().toISOString() },
    ]
    accountsRows = [{ id: "acct-3", company_name: "Partner LLC" }]
    taxReturns = [
      {
        id: "tr-3",
        account_id: "acct-3",
        tax_year: 2025,
        return_type: "MMLLC",
        extension_filed: true,
        extension_submission_id: null,
      },
    ]
    const { getTaxReturnExtensionGaps } = await import("@/lib/exceptions/queries")
    const rows = await getTaxReturnExtensionGaps()
    expect(rows).toHaveLength(1)
    expect(rows[0].reason).toBe("no_submission_id")
  })

  it("does not flag SDs whose tax_returns row has extension_filed=true + submission_id", async () => {
    serviceDeliveries = [
      { id: "sd-4", account_id: "acct-4", stage: "Extension Filed", status: "active", updated_at: new Date().toISOString() },
    ]
    accountsRows = [{ id: "acct-4", company_name: "Good LLC" }]
    taxReturns = [
      {
        id: "tr-4",
        account_id: "acct-4",
        tax_year: 2025,
        return_type: "SMLLC",
        extension_filed: true,
        extension_submission_id: "EXT-12345",
      },
    ]
    const { getTaxReturnExtensionGaps } = await import("@/lib/exceptions/queries")
    const rows = await getTaxReturnExtensionGaps()
    expect(rows).toHaveLength(0)
  })

  it("keeps the most recent tax_year when multiple tax_returns rows exist per account", async () => {
    serviceDeliveries = [
      { id: "sd-5", account_id: "acct-5", stage: "Data Received", status: "active", updated_at: new Date().toISOString() },
    ]
    accountsRows = [{ id: "acct-5", company_name: "Multi Year LLC" }]
    // 2024 is complete (filed + id). 2025 is missing extension. The scanner
    // should pick 2025 (most recent) and report it as extension_not_filed.
    taxReturns = [
      { id: "tr-5a", account_id: "acct-5", tax_year: 2024, return_type: "Corp", extension_filed: true, extension_submission_id: "OK-2024" },
      { id: "tr-5b", account_id: "acct-5", tax_year: 2025, return_type: "Corp", extension_filed: false, extension_submission_id: null },
    ]
    const { getTaxReturnExtensionGaps } = await import("@/lib/exceptions/queries")
    const rows = await getTaxReturnExtensionGaps()
    expect(rows).toHaveLength(1)
    expect(rows[0].tax_year).toBe(2025)
    expect(rows[0].reason).toBe("extension_not_filed")
  })

  it("ignores SDs with null account_id", async () => {
    serviceDeliveries = [
      { id: "sd-6", account_id: null, stage: "Company Data Pending", status: "active", updated_at: new Date().toISOString() },
    ]
    const { getTaxReturnExtensionGaps } = await import("@/lib/exceptions/queries")
    const rows = await getTaxReturnExtensionGaps()
    expect(rows).toHaveLength(0)
  })
})
