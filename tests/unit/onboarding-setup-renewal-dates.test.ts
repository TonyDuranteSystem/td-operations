/**
 * DT-C — onboarding-setup must not overwrite existing renewal dates.
 *
 * The wizard handler's "renewal_dates" step (step 5b in onboarding-setup.ts)
 * fills `accounts.cmra_renewal_date` and `accounts.annual_report_due_date`
 * with default values when the account is fresh.
 *
 * Annual advancement of these dates is owned elsewhere:
 *   - lib/operations/file-renewal.ts bumps RA / annual-report dates +1 year
 *     when a renewal is filed.
 *   - lib/installment-handler.ts sets `cmra_renewal_date = ${year}-12-31`
 *     when each year's installment is paid.
 *
 * If the wizard handler re-runs on an account that already has a date set
 * (either by one of those flows or by a manual audit-panel adjustment), it
 * MUST leave the existing value alone. A past date here means a renewal
 * is overdue — silently overwriting it would mask the lapse from the
 * cron checks at app/api/cron/{ra-renewal-check,annual-report-check}.
 *
 * Contract:
 *   - cmra_renewal_date / annual_report_due_date = null  → write default
 *   - existing date (past or future)                     → preserve, log skip
 *   - state = NM                                         → never write annual_report
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

// ── accounts mock — captures update payloads, returns configurable current dates ──
type CurrentDates = {
  cmra_renewal_date: string | null
  annual_report_due_date: string | null
}

let currentDates: CurrentDates = { cmra_renewal_date: null, annual_report_due_date: null }
let accountsUpdateCalls: Array<Record<string, unknown>> = []

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "accounts") {
        return {
          select: (cols: string) => {
            // Step 5b reads the current renewal-date columns before deciding.
            if (typeof cols === "string" && cols.includes("cmra_renewal_date")) {
              return {
                eq: () => ({
                  single: () => Promise.resolve({ data: currentDates, error: null }),
                }),
              }
            }
            // Any other accounts.select chain — return a generic no-op chain.
            const noop = () => stub
            const stub: Record<string, unknown> = {
              select: noop, eq: noop, neq: noop, in: noop, or: noop, not: noop,
              order: noop, limit: noop,
              single: () => Promise.resolve({ data: null, error: null }),
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }
            return stub
          },
          update: (patch: Record<string, unknown>) => {
            accountsUpdateCalls.push(patch)
            // Two call shapes must both work: the portal step awaits
            // .update().eq() directly, while the renewal-dates helper chains
            // .update().eq().is(col, null).select() (per-column guarded fill).
            const term = Promise.resolve({ data: [{ id: "acc-test" }], error: null })
            return {
              eq: () => Object.assign(
                {
                  is: () => ({ select: () => term }),
                },
                {
                  then: term.then.bind(term),
                  catch: term.catch.bind(term),
                },
              ),
            }
          },
          insert: () => Promise.resolve({ data: null, error: null }),
        }
      }
      // Everything else: pure no-op stub.
      const noop = () => stub
      const stub: Record<string, unknown> = {
        select: noop, eq: noop, neq: noop, in: noop, or: noop, not: noop,
        order: noop, limit: noop,
        single: () => Promise.resolve({ data: null, error: null }),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        insert: () => Promise.resolve({ data: null, error: null }),
        update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      }
      return stub
    },
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
  },
}))

// ── inert helper mocks (handler has many side effects we don't care about here)
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
vi.mock("@/lib/operations/service-delivery", () => ({
  createSD: vi.fn(() => Promise.resolve({ id: "sd-test", stage: "Data Collection", service_type: "x", service_name: "x" })),
}))

import { handleOnboardingSetup } from "@/lib/jobs/handlers/onboarding-setup"

const currentYear = new Date().getFullYear()
const nextYear = currentYear + 1

function makeJob(opts: {
  state_of_formation: string
  formation_date?: string
}) {
  return {
    id: "job-test",
    job_type: "onboarding_setup",
    payload: {
      account_id: "acc-test",
      contact_id: "contact-test",
      company_name: "Test Company LLC",
      entity_type: "SMLLC",
      state_of_formation: opts.state_of_formation,
      submitted_data: {
        formation_date: opts.formation_date || "",
        // Skip tax-return SD branch to keep the test focused.
        tax_return_previous_year_filed: "yes",
        tax_return_current_year_filed: "yes",
      },
      source: "test",
    },
    status: "processing",
    attempts: 1,
    max_attempts: 3,
    created_at: new Date().toISOString(),
  }
}

// The shared helper (lib/operations/renewal-dates.ts) writes ONE guarded
// update per column — merge every captured payload's renewal keys so the
// assertions stay about WHAT was written, not how many statements it took.
function findRenewalUpdate(): Record<string, unknown> | undefined {
  const keys = ["cmra_renewal_date", "annual_report_due_date", "ra_renewal_date"] as const
  const merged: Record<string, unknown> = {}
  for (const p of accountsUpdateCalls) {
    for (const k of keys) if (k in p) merged[k] = p[k]
  }
  return Object.keys(merged).length ? merged : undefined
}

beforeEach(() => {
  currentDates = { cmra_renewal_date: null, annual_report_due_date: null }
  accountsUpdateCalls = []
  vi.clearAllMocks()
})

describe("onboarding-setup step 5b — renewal-date null-only guard", () => {
  it("writes both defaults when both columns are null (FL, fresh account)", async () => {
    currentDates = { cmra_renewal_date: null, annual_report_due_date: null }

    const result = await handleOnboardingSetup(makeJob({ state_of_formation: "FL" }) as never)
    const upd = findRenewalUpdate()

    expect(upd).toBeDefined()
    expect(upd!.cmra_renewal_date).toBe(`${currentYear}-12-31`)
    expect(upd!.annual_report_due_date).toBe(`${nextYear}-05-01`)

    const step = result.steps.find(s => s.name === "renewal_dates")
    expect(step?.status).toBe("ok")
  })

  it("preserves a future cmra_renewal_date and writes the AR default (DE, partial state)", async () => {
    currentDates = { cmra_renewal_date: `${nextYear}-12-31`, annual_report_due_date: null }

    const result = await handleOnboardingSetup(makeJob({ state_of_formation: "DE" }) as never)
    const upd = findRenewalUpdate()

    // CMRA must NOT be in the update payload.
    expect(upd).toBeDefined()
    expect("cmra_renewal_date" in upd!).toBe(false)
    // AR default written (DE = June 1 next year).
    expect(upd!.annual_report_due_date).toBe(`${nextYear}-06-01`)

    const step = result.steps.find(s => s.name === "renewal_dates")
    expect(step?.status).toBe("ok")
  })

  it("preserves a PAST cmra_renewal_date — does not mask an overdue renewal (FL)", async () => {
    const pastDate = `${currentYear - 2}-12-31`
    currentDates = { cmra_renewal_date: pastDate, annual_report_due_date: null }

    const result = await handleOnboardingSetup(makeJob({ state_of_formation: "FL" }) as never)
    const upd = findRenewalUpdate()

    // Even though it's in the past, we must NOT overwrite — the cron checks
    // depend on the lapse staying visible.
    expect(upd).toBeDefined()
    expect("cmra_renewal_date" in upd!).toBe(false)

    const step = result.steps.find(s => s.name === "renewal_dates")
    expect(step?.status).toBe("ok")
  })

  it("preserves a future annual_report_due_date and still writes CMRA default (WY)", async () => {
    const futureAR = `${nextYear + 1}-03-01`
    currentDates = { cmra_renewal_date: null, annual_report_due_date: futureAR }

    const result = await handleOnboardingSetup(makeJob({
      state_of_formation: "WY",
      formation_date: "2024-03-15",
    }) as never)
    const upd = findRenewalUpdate()

    expect(upd).toBeDefined()
    expect(upd!.cmra_renewal_date).toBe(`${currentYear}-12-31`)
    expect("annual_report_due_date" in upd!).toBe(false)

    const step = result.steps.find(s => s.name === "renewal_dates")
    expect(step?.status).toBe("ok")
  })

  it("preserves both — no update issued, step still reports ok", async () => {
    currentDates = {
      cmra_renewal_date: `${nextYear}-12-31`,
      annual_report_due_date: `${nextYear + 1}-05-01`,
    }

    const result = await handleOnboardingSetup(makeJob({ state_of_formation: "FL" }) as never)
    const upd = findRenewalUpdate()

    // No renewal-date keys should land on the accounts table.
    expect(upd).toBeUndefined()

    const step = result.steps.find(s => s.name === "renewal_dates")
    expect(step?.status).toBe("ok")
    expect(step?.detail).toContain("No writes")
  })

  it("NM never writes annual_report_due_date — even when null", async () => {
    currentDates = { cmra_renewal_date: null, annual_report_due_date: null }

    const result = await handleOnboardingSetup(makeJob({ state_of_formation: "NM" }) as never)
    const upd = findRenewalUpdate()

    // CMRA still gets the default; annual_report stays absent (NM has no AR).
    expect(upd).toBeDefined()
    expect(upd!.cmra_renewal_date).toBe(`${currentYear}-12-31`)
    expect("annual_report_due_date" in upd!).toBe(false)

    const step = result.steps.find(s => s.name === "renewal_dates")
    expect(step?.status).toBe("ok")
  })

  it("WY writes annual_report at the formation anniversary month", async () => {
    currentDates = { cmra_renewal_date: null, annual_report_due_date: null }

    const result = await handleOnboardingSetup(makeJob({
      state_of_formation: "WY",
      formation_date: "2023-08-22",
    }) as never)
    const upd = findRenewalUpdate()

    expect(upd).toBeDefined()
    expect(upd!.annual_report_due_date).toBe(`${nextYear}-08-01`)

    const step = result.steps.find(s => s.name === "renewal_dates")
    expect(step?.status).toBe("ok")
  })
})
