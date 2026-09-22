/**
 * lib/operations/onboarding-review.ts — confirmPortalWizardOnboarding
 * (dev job bc2a8f7f, 2026-09-20)
 *
 * The Confirm action for the REAL client journey (logged-in portal wizard).
 * Unlike applyOnboardingReview (the separate manual token-link tool), this
 * does NOT create the Account/Contact inline — it records who reviewed the
 * submission and re-enqueues the onboarding_setup job, which does the
 * actual setup once it sees reviewed_at is set.
 *
 * Covers:
 *   - rejects a submission that isn't source='portal_wizard'
 *   - rejects a submission that isn't status='completed'
 *   - already-reviewed short-circuit (no re-enqueue)
 *   - TOCTOU race: reviewed_at lock is gated on IS NULL
 *   - happy path: locks reviewed_at, enqueues the job, reports pending=true
 *     when no account exists yet
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

interface SubRow {
  id: string
  token: string
  source: string | null
  status: string
  state: string
  entity_type: string
  account_id: string | null
  contact_id: string | null
  lead_id: string | null
  reviewed_at: string | null
  reviewed_by: string | null
  submitted_data: Record<string, unknown>
  upload_paths: string[]
}

let submissionRow: SubRow | null = null
let lockAcquired = true
const updateCalls: Array<Record<string, unknown>> = []

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== "onboarding_submissions") {
        throw new Error(`Unexpected table in test: ${table}`)
      }
      const chain: Record<string, unknown> = {}
      chain.select = vi.fn(() => chain)
      chain.eq = vi.fn(() => chain)
      chain.is = vi.fn(() => chain)
      chain.maybeSingle = vi.fn(async () => ({ data: submissionRow, error: null }))
      chain.update = vi.fn((patch: Record<string, unknown>) => {
        updateCalls.push(patch)
        return {
          eq: () => ({
            is: () => ({
              select: () => Promise.resolve(
                lockAcquired
                  ? { data: [{ id: submissionRow?.id }], error: null }
                  : { data: [], error: null },
              ),
            }),
          }),
        }
      })
      return chain
    },
  },
}))

const enqueueJobMock = vi.fn(async () => ({ id: "job-123" }))
vi.mock("@/lib/jobs/queue", () => ({ enqueueJob: enqueueJobMock }))

import { confirmPortalWizardOnboarding } from "@/lib/operations/onboarding-review"

function makeSubmission(overrides: Partial<SubRow> = {}): SubRow {
  return {
    id: "sub-1",
    token: "tok-1",
    source: "portal_wizard",
    status: "completed",
    state: "FL",
    entity_type: "SMLLC",
    account_id: null,
    contact_id: "contact-1",
    lead_id: null,
    reviewed_at: null,
    reviewed_by: null,
    submitted_data: { company_name: "Maria Test LLC", state_of_formation: "Florida" },
    upload_paths: [],
    ...overrides,
  }
}

beforeEach(() => {
  submissionRow = null
  lockAcquired = true
  updateCalls.length = 0
  enqueueJobMock.mockClear()
})

describe("confirmPortalWizardOnboarding", () => {
  it("rejects a submission that isn't from the portal wizard", async () => {
    submissionRow = makeSubmission({ source: null })
    const result = await confirmPortalWizardOnboarding("sub-1", "staff@tonydurante.us")
    expect(result.ok).toBe(false)
    expect(result.error).toContain("not a portal-wizard submission")
    expect(enqueueJobMock).not.toHaveBeenCalled()
  })

  it("rejects a submission that isn't completed yet", async () => {
    submissionRow = makeSubmission({ status: "pending" })
    const result = await confirmPortalWizardOnboarding("sub-1", "staff@tonydurante.us")
    expect(result.ok).toBe(false)
    expect(result.error).toContain("not completed")
    expect(enqueueJobMock).not.toHaveBeenCalled()
  })

  it("short-circuits when already reviewed — no second enqueue", async () => {
    submissionRow = makeSubmission({ reviewed_at: "2026-09-20T10:00:00Z", reviewed_by: "luca@tonydurante.us" })
    const result = await confirmPortalWizardOnboarding("sub-1", "staff@tonydurante.us")
    expect(result.ok).toBe(true)
    expect(result.alreadyApplied).toBe(true)
    expect(result.lines[0]).toContain("luca@tonydurante.us")
    expect(enqueueJobMock).not.toHaveBeenCalled()
  })

  it("TOCTOU race: another confirm won the lock first — reports alreadyApplied, does not enqueue twice", async () => {
    submissionRow = makeSubmission()
    lockAcquired = false
    const result = await confirmPortalWizardOnboarding("sub-1", "staff@tonydurante.us")
    expect(result.ok).toBe(true)
    expect(result.alreadyApplied).toBe(true)
    expect(enqueueJobMock).not.toHaveBeenCalled()
  })

  it("happy path: locks reviewed_at with the real actor, enqueues onboarding_setup with source cleared, reports pending=true (no account yet)", async () => {
    submissionRow = makeSubmission()
    const result = await confirmPortalWizardOnboarding("sub-1", "antonio.durante@tonydurante.us")

    expect(result.ok).toBe(true)
    expect(result.alreadyApplied).toBe(false)
    expect(result.pending).toBe(true)

    // The lock update carried the REAL actor, not a hardcoded string.
    const lockPatch = updateCalls.find((c) => c.reviewed_by)
    expect(lockPatch).toMatchObject({ reviewed_by: "antonio.durante@tonydurante.us" })

    expect(enqueueJobMock).toHaveBeenCalledTimes(1)
    const [enqueueArgs] = enqueueJobMock.mock.calls[0]
    expect(enqueueArgs.job_type).toBe("onboarding_setup")
    expect(enqueueArgs.payload.submission_id).toBe("sub-1")
    expect(enqueueArgs.payload.source).toBeUndefined()
  })

  it("reports pending=false when the account already exists on the submission", async () => {
    submissionRow = makeSubmission({ account_id: "acc-already-there" })
    const result = await confirmPortalWizardOnboarding("sub-1", "antonio.durante@tonydurante.us")
    expect(result.pending).toBe(false)
    expect(result.account_id).toBe("acc-already-there")
  })
})
