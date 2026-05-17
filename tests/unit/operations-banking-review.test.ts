/**
 * Slice 8 — lib/operations/banking-review.ts unit tests
 *
 * Covers:
 *   - already-applied short-circuit (reviewed_at IS NOT NULL)
 *   - happy path (services updated, reviewed_at flipped, provider returned)
 *   - submission not found → ok=false
 *   - submission status not completed → ok=false
 *   - services table missing row → no_row (not an error)
 *   - services update error surfaced but doesn't fail the helper
 *   - TOCTOU race: reviewed_at flip is gated on reviewed_at IS NULL
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

// ─── Mock state ──────────────────────────────────────────

interface SubRow {
  id: string
  token: string
  provider: string
  account_id: string | null
  contact_id: string | null
  reviewed_at: string | null
  status: string
}

let submissionRow: SubRow | null = null
let accountRow: { company_name: string } | null = null
let servicesRow: { id: string } | null = null
let servicesUpdateError: { message: string } | null = null
let markReviewedError: { message: string } | null = null

const updateCalls: Array<{ table: string; payload: Record<string, unknown>; filters: Record<string, string | null> }> = []

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const filters: Record<string, string | null> = {}
      let pendingUpdate: Record<string, unknown> | null = null
      let pendingSelect = ""

      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        select: vi.fn((cols: string) => {
          pendingSelect = cols
          return chain
        }),
        update: vi.fn((payload: Record<string, unknown>) => {
          pendingUpdate = payload
          return chain
        }),
        eq: vi.fn((col: string, value: string) => {
          filters[col] = value
          return chain
        }),
        is: vi.fn((col: string, value: null) => {
          filters[`${col}__is`] = value
          return chain
        }),
        maybeSingle: vi.fn(() => Promise.resolve(resolveValue())),
        single: vi.fn(() => Promise.resolve(resolveValue())),
        then: (resolve: (v: unknown) => void) => resolve(resolveValue()),
      })

      function resolveValue() {
        if (pendingUpdate) {
          updateCalls.push({ table, payload: pendingUpdate, filters: { ...filters } })
          const err = table === "services" ? servicesUpdateError : table === "banking_submissions" ? markReviewedError : null
          pendingUpdate = null
          return { data: null, error: err }
        }
        // Read paths
        if (table === "banking_submissions") {
          return { data: submissionRow, error: null }
        }
        if (table === "accounts") {
          return { data: accountRow, error: null }
        }
        if (table === "services") {
          return { data: servicesRow, error: null }
        }
        // Silence linter
        void pendingSelect
        return { data: null, error: null }
      }
      return chain
    },
  },
}))

import { approveAndApplyBankingReview } from "@/lib/operations/banking-review"

beforeEach(() => {
  submissionRow = null
  accountRow = null
  servicesRow = null
  servicesUpdateError = null
  markReviewedError = null
  updateCalls.length = 0
})

describe("approveAndApplyBankingReview", () => {
  it("returns ok=false when submission not found", async () => {
    submissionRow = null
    const result = await approveAndApplyBankingReview({ submission_id: "missing", actor: "test" })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not found/i)
  })

  it("returns ok=false when status is not completed or reviewed", async () => {
    submissionRow = {
      id: "s1", token: "tk-1", provider: "payset",
      account_id: "a1", contact_id: null, reviewed_at: null, status: "sent",
    }
    const result = await approveAndApplyBankingReview({ submission_id: "s1", actor: "test" })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not completed/i)
  })

  it("short-circuits with alreadyApplied=true when reviewed_at is set", async () => {
    submissionRow = {
      id: "s1", token: "tk-1", provider: "payset",
      account_id: "a1", contact_id: null,
      reviewed_at: "2026-05-17T12:00:00Z", status: "reviewed",
    }
    accountRow = { company_name: "ACME LLC" }
    const result = await approveAndApplyBankingReview({ submission_id: "s1", actor: "test" })
    expect(result.ok).toBe(true)
    expect(result.alreadyApplied).toBe(true)
    expect(result.provider).toBe("payset")
    expect(result.company_name).toBe("ACME LLC")
    // No update calls when already applied
    expect(updateCalls.length).toBe(0)
  })

  it("happy path: updates services, marks reviewed, returns provider + company", async () => {
    submissionRow = {
      id: "s1", token: "tk-1", provider: "relay",
      account_id: "a1", contact_id: "c1", reviewed_at: null, status: "completed",
    }
    accountRow = { company_name: "ACME LLC" }
    servicesRow = { id: "svc-1" }

    const result = await approveAndApplyBankingReview({ submission_id: "s1", actor: "test-actor" })
    expect(result.ok).toBe(true)
    expect(result.alreadyApplied).toBeUndefined()
    expect(result.provider).toBe("relay")
    expect(result.company_name).toBe("ACME LLC")
    expect(result.services_update).toBe("updated")

    const servicesUpdate = updateCalls.find((u) => u.table === "services")
    expect(servicesUpdate).toBeDefined()
    expect(servicesUpdate?.payload).toMatchObject({ status: "Data Collected" })

    const submissionUpdate = updateCalls.find((u) => u.table === "banking_submissions")
    expect(submissionUpdate).toBeDefined()
    expect(submissionUpdate?.payload).toMatchObject({
      status: "reviewed",
      reviewed_by: "test-actor",
    })
    // TOCTOU guard: gated on reviewed_at IS NULL
    expect(submissionUpdate?.filters["reviewed_at__is"]).toBeNull()
  })

  it("services no_row when no Banking Fintech services row exists", async () => {
    submissionRow = {
      id: "s1", token: "tk-1", provider: "payset",
      account_id: "a1", contact_id: null, reviewed_at: null, status: "completed",
    }
    accountRow = { company_name: "ACME LLC" }
    servicesRow = null

    const result = await approveAndApplyBankingReview({ submission_id: "s1", actor: "test" })
    expect(result.ok).toBe(true)
    expect(result.services_update).toBe("no_row")
    // banking_submissions still marked reviewed
    expect(updateCalls.find((u) => u.table === "banking_submissions")).toBeDefined()
    expect(updateCalls.find((u) => u.table === "services")).toBeUndefined()
  })

  it("services error surfaced but does not fail the helper", async () => {
    submissionRow = {
      id: "s1", token: "tk-1", provider: "payset",
      account_id: "a1", contact_id: null, reviewed_at: null, status: "completed",
    }
    accountRow = { company_name: "ACME LLC" }
    servicesRow = { id: "svc-1" }
    servicesUpdateError = { message: "RLS denied" }

    const result = await approveAndApplyBankingReview({ submission_id: "s1", actor: "test" })
    expect(result.ok).toBe(true)
    expect(result.services_update).toBe("error")
    expect(result.services_update_error).toBe("RLS denied")
    // reviewed_at still flipped
    expect(updateCalls.find((u) => u.table === "banking_submissions")).toBeDefined()
  })

  it("falls back to token as company name when no account row", async () => {
    submissionRow = {
      id: "s1", token: "fallback-token", provider: "payset",
      account_id: null, contact_id: null, reviewed_at: null, status: "completed",
    }
    accountRow = null
    const result = await approveAndApplyBankingReview({ submission_id: "s1", actor: "test" })
    expect(result.ok).toBe(true)
    expect(result.company_name).toBe("fallback-token")
  })

  it("normalizes unknown provider to payset", async () => {
    submissionRow = {
      id: "s1", token: "tk-1", provider: "unknown_provider",
      account_id: "a1", contact_id: null, reviewed_at: null, status: "completed",
    }
    accountRow = { company_name: "ACME" }
    const result = await approveAndApplyBankingReview({ submission_id: "s1", actor: "test" })
    expect(result.provider).toBe("payset")
  })
})
