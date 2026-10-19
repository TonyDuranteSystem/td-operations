/**
 * Slice 8 — lib/operations/tax-review.ts unit tests
 *
 * Covers:
 *   - already-applied short-circuit (reviewed_at IS NOT NULL)
 *   - happy path: enqueues job + marks reviewed
 *   - submission not found → ok=false
 *   - submission status not completed → ok=false
 *   - enqueueJob throws → ok=false with error
 *   - TOCTOU race: reviewed_at flip is gated on reviewed_at IS NULL
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

interface SubRow {
  id: string
  token: string
  account_id: string | null
  contact_id: string | null
  tax_year: number
  tax_return_id: string | null
  changed_fields: Record<string, unknown> | null
  reviewed_at: string | null
  status: string
}

let submissionRow: SubRow | null = null
let accountRow: { company_name: string } | null = null
let markReviewedError: { message: string } | null = null
let enqueueShouldThrow = false
let enqueueReturnsId: string = "job-xyz"
let existingJobs: Array<{ id: string }> = []
/** set: the enqueue loses the race — the database refuses the duplicate and this job (the other click's) is already there */
let duplicateWinner: string | null = null
let jobLookupError: { message: string } | null = null

const updateCalls: Array<{ table: string; payload: Record<string, unknown>; filters: Record<string, string | null> }> = []
const enqueueCalls: Array<Record<string, unknown>> = []

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const filters: Record<string, string | null> = {}
      let pendingUpdate: Record<string, unknown> | null = null

      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        select: vi.fn(() => chain),
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
        in: vi.fn(() => chain),
        order: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        maybeSingle: vi.fn(() => Promise.resolve(resolveValue())),
        single: vi.fn(() => Promise.resolve(resolveValue())),
        then: (resolve: (v: unknown) => void) => resolve(resolveValue()),
      })

      function resolveValue() {
        if (pendingUpdate) {
          updateCalls.push({ table, payload: pendingUpdate, filters: { ...filters } })
          const err = table === "tax_return_submissions" ? markReviewedError : null
          pendingUpdate = null
          return { data: null, error: err }
        }
        if (table === "job_queue") {
          return { data: jobLookupError ? null : existingJobs, error: jobLookupError }
        }
        if (table === "tax_return_submissions") {
          return { data: submissionRow, error: null }
        }
        if (table === "accounts") {
          return { data: accountRow, error: null }
        }
        return { data: null, error: null }
      }
      return chain
    },
  },
}))

vi.mock("@/lib/jobs/queue", () => ({
  enqueueJob: vi.fn(async (params: Record<string, unknown>) => {
    enqueueCalls.push(params)
    if (duplicateWinner) { existingJobs = [{ id: duplicateWinner }]; throw new Error('duplicate key value violates unique constraint "uq_job_queue_tax_review_apply"') }
    if (enqueueShouldThrow) throw new Error("enqueue failed: connection refused")
    return { id: enqueueReturnsId }
  }),
}))

import { approveAndApplyTaxReview } from "@/lib/operations/tax-review"

beforeEach(() => {
  submissionRow = null
  accountRow = null
  markReviewedError = null
  enqueueShouldThrow = false
  enqueueReturnsId = "job-xyz"
  existingJobs = []
  duplicateWinner = null
  jobLookupError = null
  updateCalls.length = 0
  enqueueCalls.length = 0
})

describe("approveAndApplyTaxReview", () => {
  it("returns ok=false when submission not found", async () => {
    submissionRow = null
    const result = await approveAndApplyTaxReview({ submission_id: "missing", actor: "test" })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not found/i)
    expect(enqueueCalls.length).toBe(0)
  })

  it("returns ok=false when status is not completed", async () => {
    submissionRow = {
      id: "s1", token: "tk", account_id: "a1", contact_id: null,
      tax_year: 2025, tax_return_id: null, changed_fields: null,
      reviewed_at: null, status: "sent",
    }
    const result = await approveAndApplyTaxReview({ submission_id: "s1", actor: "test" })
    expect(result.ok).toBe(false)
    expect(enqueueCalls.length).toBe(0)
  })

  it("short-circuits with alreadyApplied=true when reviewed_at is set", async () => {
    submissionRow = {
      id: "s1", token: "tk", account_id: "a1", contact_id: "c1",
      tax_year: 2024, tax_return_id: "tr-1", changed_fields: null,
      reviewed_at: "2026-05-17T12:00:00Z", status: "reviewed",
    }
    accountRow = { company_name: "ACME LLC" }
    const result = await approveAndApplyTaxReview({ submission_id: "s1", actor: "test" })
    expect(result.ok).toBe(true)
    expect(result.alreadyApplied).toBe(true)
    expect(result.company_name).toBe("ACME LLC")
    expect(result.tax_year).toBe(2024)
    expect(enqueueCalls.length).toBe(0)
    expect(updateCalls.length).toBe(0)
  })

  it("happy path: enqueues job + marks reviewed + returns job_id", async () => {
    submissionRow = {
      id: "s1", token: "tk", account_id: "a1", contact_id: "c1",
      tax_year: 2025, tax_return_id: "tr-1",
      changed_fields: { total_revenue: { old: 100, new: 200 } },
      reviewed_at: null, status: "completed",
    }
    accountRow = { company_name: "ACME LLC" }
    enqueueReturnsId = "job-abc-123"

    const result = await approveAndApplyTaxReview({ submission_id: "s1", actor: "claude" })
    expect(result.ok).toBe(true)
    expect(result.job_id).toBe("job-abc-123")
    expect(result.tax_year).toBe(2025)

    expect(enqueueCalls.length).toBe(1)
    expect(enqueueCalls[0]).toMatchObject({
      job_type: "tax_form_setup",
      payload: expect.objectContaining({
        submission_id: "s1",
        account_id: "a1",
        contact_id: "c1",
        tax_return_id: "tr-1",
      }),
      created_by: "claude",
    })

    const submissionUpdate = updateCalls.find((u) => u.table === "tax_return_submissions")
    expect(submissionUpdate).toBeDefined()
    expect(submissionUpdate?.payload).toMatchObject({
      status: "reviewed",
      reviewed_by: "claude",
    })
    expect(submissionUpdate?.filters["reviewed_at__is"]).toBeNull()
  })

  it("enqueueJob throws → ok=false with error", async () => {
    submissionRow = {
      id: "s1", token: "tk", account_id: "a1", contact_id: null,
      tax_year: 2025, tax_return_id: null, changed_fields: null,
      reviewed_at: null, status: "completed",
    }
    accountRow = { company_name: "ACME" }
    enqueueShouldThrow = true

    const result = await approveAndApplyTaxReview({ submission_id: "s1", actor: "test" })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/connection refused/i)
    // reviewed_at NOT flipped when enqueue fails
    expect(updateCalls.find((u) => u.table === "tax_return_submissions")).toBeUndefined()
  })

  it("falls back to token as company name when no account row", async () => {
    submissionRow = {
      id: "s1", token: "fallback-token", account_id: null, contact_id: null,
      tax_year: 2025, tax_return_id: null, changed_fields: null,
      reviewed_at: null, status: "completed",
    }
    accountRow = null
    const result = await approveAndApplyTaxReview({ submission_id: "s1", actor: "test" })
    expect(result.ok).toBe(true)
    expect(result.company_name).toBe("fallback-token")
  })

  const pending = (): SubRow => ({
    id: "s1", token: "tk", account_id: "a1", contact_id: null,
    tax_year: 2025, tax_return_id: null, changed_fields: null,
    reviewed_at: null, status: "completed",
  })

  it("the review job is enqueued ONCE: it carries the review_apply mark the next run looks for", async () => {
    submissionRow = pending()
    accountRow = { company_name: "ACME" }
    await approveAndApplyTaxReview({ submission_id: "s1", actor: "test" })
    expect(enqueueCalls).toHaveLength(1)
    expect((enqueueCalls[0].payload as Record<string, unknown>).review_apply).toBe(true)
  })

  it("a SECOND run after a leave-unreviewed run does NOT enqueue again (no reset, no second email, no overwrite): it only marks reviewed", async () => {
    submissionRow = pending()
    accountRow = { company_name: "ACME" }
    existingJobs = [{ id: "job-first" }]
    const result = await approveAndApplyTaxReview({ submission_id: "s1", actor: "test" })
    expect(result.ok).toBe(true)
    expect(result.correctionsAlreadyApplied).toBe(true)
    expect(result.job_id).toBe("job-first")
    expect(enqueueCalls).toEqual([])
    // the filing problem is fixed now, so THIS run stamps the form reviewed
    expect(updateCalls.find((u) => u.table === "tax_return_submissions")?.payload.status).toBe("reviewed")
  })

  it("leaveUnreviewed: applies once, stamps nothing; a repeat while still unfiled enqueues nothing and stamps nothing", async () => {
    submissionRow = pending()
    accountRow = { company_name: "ACME" }
    const first = await approveAndApplyTaxReview({ submission_id: "s1", actor: "test", leaveUnreviewed: true })
    expect(first.ok).toBe(true)
    expect(enqueueCalls).toHaveLength(1)
    expect((enqueueCalls[0].payload as Record<string, unknown>).leave_unreviewed).toBe(true)
    expect(updateCalls.find((u) => u.table === "tax_return_submissions")).toBeUndefined()
    enqueueCalls.length = 0
    existingJobs = [{ id: "job-first" }]
    const second = await approveAndApplyTaxReview({ submission_id: "s1", actor: "test", leaveUnreviewed: true })
    expect(second.correctionsAlreadyApplied).toBe(true)
    expect(enqueueCalls).toEqual([])
    expect(updateCalls.find((u) => u.table === "tax_return_submissions")).toBeUndefined()
  })

  it("two near-simultaneous reviews: the loser's insert is refused by the database → it is 'already applied' with the winner's job, never an error and never a second job", async () => {
    submissionRow = pending()
    accountRow = { company_name: "ACME" }
    duplicateWinner = "job-winner"
    const result = await approveAndApplyTaxReview({ submission_id: "s1", actor: "test" })
    expect(result.ok).toBe(true)
    expect(result.correctionsAlreadyApplied).toBe(true)
    expect(result.job_id).toBe("job-winner")
  })

  it("an unreadable queue is never read as 'nothing queued' (a duplicate apply is the dangerous direction)", async () => {
    submissionRow = pending()
    accountRow = { company_name: "ACME" }
    jobLookupError = { message: "queue down" }
    const result = await approveAndApplyTaxReview({ submission_id: "s1", actor: "test" })
    expect(result.ok).toBe(false)
    expect(enqueueCalls).toEqual([])
  })
})
