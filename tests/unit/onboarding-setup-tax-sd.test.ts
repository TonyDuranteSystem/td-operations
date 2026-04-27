/**
 * Fix 4 characterization — onboarding-setup step 4 creates a Tax Return SD
 * for the current year when tax_return_current_year_filed="no".
 *
 * The previous year SD is created by activate-service at payment time
 * (Tax Return in bundled_pipelines). The current year has no equivalent
 * path — this handler is the only place it gets created.
 *
 * Contract:
 *   - tax_return_current_year_filed="no" AND no existing SD
 *     → createSD called with service_type="Tax Return",
 *       service_name="Tax Return - {company} {year}",
 *       target_stage="1st Installment Paid"
 *   - tax_return_current_year_filed="no" AND SD already exists
 *     → createSD NOT called (idempotent)
 *   - tax_return_current_year_filed="yes" (or any non-"no" value)
 *     → createSD NOT called
 *   - tax_return_previous_year_filed="no"
 *     → createSD NOT called (previous year is handled by activate-service)
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

// ── createSD capture ────────────────────────────────────────────────────────
let createSDCalls: Array<Record<string, unknown>> = []

vi.mock("@/lib/operations/service-delivery", () => ({
  createSD: vi.fn((params: Record<string, unknown>) => {
    createSDCalls.push(params)
    return Promise.resolve({
      id: "test-sd-id",
      stage: params.target_stage,
      service_type: params.service_type,
      service_name: params.service_name,
    })
  }),
}))

// ── supabaseAdmin mock ──────────────────────────────────────────────────────
let existingTaxSD: { id: string } | null = null
let existingTaxReturn: { id: string } | null = null

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "service_deliveries") {
        const chain: Record<string, unknown> = {}
        const noop = () => chain
        chain.select = noop
        chain.eq = noop
        chain.maybeSingle = () => Promise.resolve({ data: existingTaxSD, error: null })
        return chain
      }
      if (table === "tax_returns") {
        const chain: Record<string, unknown> = {}
        const noop = () => chain
        chain.select = noop
        chain.eq = noop
        chain.maybeSingle = () => Promise.resolve({ data: existingTaxReturn, error: null })
        chain.insert = () => Promise.resolve({ error: null })
        return chain
      }
      // All other tables: no-op
      const noop = () => stub
      const stub: Record<string, unknown> = {
        select: noop, eq: noop, neq: noop, in: noop, or: noop, not: noop,
        order: noop, limit: noop, single: () => Promise.resolve({ data: null, error: null }),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        insert: () => Promise.resolve({ data: null, error: null }),
        update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      }
      return stub
    },
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
  },
}))

// ── helpers ─────────────────────────────────────────────────────────────────
vi.mock("@/lib/google-drive", () => ({ uploadBinaryToDrive: vi.fn() }))
vi.mock("@/lib/jobs/queue", () => ({
  updateJobProgress: vi.fn(),
  completeJob: vi.fn(),
  failJob: vi.fn(),
}))
vi.mock("@/lib/account-from-wizard", () => ({
  createAccountFromWizard: vi.fn(() => Promise.resolve({ accountId: "acc-test", backfilled: { invoices: 0, payments: 0 } })),
}))
vi.mock("@/lib/jobs/validation", () => ({
  validateOnboardingData: vi.fn(() => ({ valid: true, errors: [], warnings: [] })),
  normalizeEIN: vi.fn((v: string) => v),
}))
vi.mock("@/lib/jobs/ocr-crosscheck", () => ({
  runOCRCrossCheck: vi.fn(() => Promise.resolve({ passed: true, checks: [] })),
}))
vi.mock("@/lib/utils/wizard-members", () => ({
  extractMembersFromWizardData: vi.fn(() => []),
}))

import { handleOnboardingSetup } from "@/lib/jobs/handlers/onboarding-setup"

const currentYear = new Date().getFullYear()

function makeJob(submittedData: Record<string, string>) {
  return {
    id: "job-test",
    job_type: "onboarding_setup",
    payload: {
      account_id: "acc-test",
      contact_id: "contact-test",
      company_name: "Test Company LLC",
      entity_type: "SMLLC",
      submitted_data: submittedData,
      source: "test",
    },
    status: "processing",
    attempts: 1,
    max_attempts: 3,
    created_at: new Date().toISOString(),
  }
}

beforeEach(() => {
  createSDCalls = []
  existingTaxSD = null
  existingTaxReturn = null
  vi.clearAllMocks()
})

// ─── Fix 4: current year SD creation ────────────────────────────────────────

describe("onboarding-setup Fix 4 — current year Tax Return SD", () => {
  it("creates a Tax Return SD for currentYear when tax_return_current_year_filed=no", async () => {
    await handleOnboardingSetup(makeJob({
      tax_return_previous_year_filed: "yes",
      tax_return_current_year_filed: "no",
    }) as never)

    const sdCall = createSDCalls.find(
      c => c.service_type === "Tax Return" && String(c.service_name).includes(String(currentYear))
    )
    expect(sdCall).toBeDefined()
    expect(sdCall!.service_name).toBe(`Tax Return - Test Company LLC ${currentYear}`)
    expect(sdCall!.target_stage).toBe("1st Installment Paid")
    expect(sdCall!.account_id).toBe("acc-test")
    expect(sdCall!.contact_id).toBe("contact-test")
  })

  it("does NOT create a currentYear SD when tax_return_current_year_filed=yes", async () => {
    await handleOnboardingSetup(makeJob({
      tax_return_previous_year_filed: "no",
      tax_return_current_year_filed: "yes",
    }) as never)

    const currentYearSDCall = createSDCalls.find(
      c => c.service_type === "Tax Return" && String(c.service_name).includes(String(currentYear))
    )
    expect(currentYearSDCall).toBeUndefined()
  })

  it("does NOT create a currentYear SD when SD already exists (idempotent)", async () => {
    existingTaxSD = { id: "existing-sd-id" }

    await handleOnboardingSetup(makeJob({
      tax_return_previous_year_filed: "yes",
      tax_return_current_year_filed: "no",
    }) as never)

    const currentYearSDCall = createSDCalls.find(
      c => c.service_type === "Tax Return" && String(c.service_name).includes(String(currentYear))
    )
    expect(currentYearSDCall).toBeUndefined()
  })

  it("does NOT create a Tax Return SD for previousYear (handled by activate-service)", async () => {
    const previousYear = currentYear - 1

    await handleOnboardingSetup(makeJob({
      tax_return_previous_year_filed: "no",
      tax_return_current_year_filed: "yes",
    }) as never)

    const previousYearSDCall = createSDCalls.find(
      c => c.service_type === "Tax Return" && String(c.service_name).includes(String(previousYear))
    )
    expect(previousYearSDCall).toBeUndefined()
  })
})
