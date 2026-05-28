/**
 * applyInitialRenewalDates — sets a newly-active company's compliance renewal
 * dates (CMRA + state annual report). Must preserve the exact behavior that used
 * to fire on advance into "Post-Formation + Banking" (lib/service-delivery.ts #12),
 * now invoked at EIN-completion in the Flexible Formation model. Idempotent.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const fixtures: { account: Record<string, unknown> | null } = { account: null }
const recorded: { update?: Record<string, unknown> } = {}

vi.mock("@/lib/supabase-admin", () => {
  const builder = () => {
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.eq = () => b
    b.single = async () => ({ data: fixtures.account, error: null })
    b.update = (patch: Record<string, unknown>) => {
      recorded.update = patch
      return { eq: async () => ({ error: null }) }
    }
    return b
  }
  return { supabaseAdmin: { from: () => builder() } }
})

import { applyInitialRenewalDates } from "@/lib/operations/formation-renewal-dates"

const YEAR = new Date().getFullYear()

beforeEach(() => {
  fixtures.account = null
  delete recorded.update
})

describe("applyInitialRenewalDates", () => {
  it("FL: sets CMRA (Dec 31) + annual report (next year May 1)", async () => {
    fixtures.account = { cmra_renewal_date: null, annual_report_due_date: null, state_of_formation: "Florida", formation_date: "2026-03-10" }
    const notes = await applyInitialRenewalDates("acct-fl")
    expect(recorded.update?.cmra_renewal_date).toBe(`${YEAR}-12-31`)
    expect(recorded.update?.annual_report_due_date).toBe(`${YEAR + 1}-05-01`)
    expect(notes.join(" ")).toContain("Renewal dates set")
  })

  it("DE: annual report next year June 1", async () => {
    fixtures.account = { cmra_renewal_date: null, annual_report_due_date: null, state_of_formation: "Delaware", formation_date: "2026-03-10" }
    await applyInitialRenewalDates("acct-de")
    expect(recorded.update?.annual_report_due_date).toBe(`${YEAR + 1}-06-01`)
  })

  it("WY: annual report next year on the formation month", async () => {
    fixtures.account = { cmra_renewal_date: null, annual_report_due_date: null, state_of_formation: "Wyoming", formation_date: "2026-07-22" }
    await applyInitialRenewalDates("acct-wy")
    expect(recorded.update?.annual_report_due_date).toBe(`${YEAR + 1}-07-01`)
  })

  it("NM: sets CMRA only (no annual-report rule)", async () => {
    fixtures.account = { cmra_renewal_date: null, annual_report_due_date: null, state_of_formation: "New Mexico", formation_date: "2026-03-10" }
    await applyInitialRenewalDates("acct-nm")
    expect(recorded.update?.cmra_renewal_date).toBe(`${YEAR}-12-31`)
    expect(recorded.update?.annual_report_due_date).toBeUndefined()
  })

  it("idempotent: dates already set → no write", async () => {
    fixtures.account = { cmra_renewal_date: "2026-12-31", annual_report_due_date: "2027-05-01", state_of_formation: "FL", formation_date: "2026-03-10" }
    const notes = await applyInitialRenewalDates("acct-done")
    expect(recorded.update).toBeUndefined()
    expect(notes).toHaveLength(0)
  })

  it("missing account → no-op, no throw", async () => {
    fixtures.account = null
    const notes = await applyInitialRenewalDates("acct-missing")
    expect(recorded.update).toBeUndefined()
    expect(notes).toHaveLength(0)
  })
})
