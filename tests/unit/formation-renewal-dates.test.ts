/**
 * applyStateAnnualReportDate — sets the Secretary-of-State annual-report due date
 * computed FROM THE FORMATION DATE (Antonio 2026-05-28): the annual report renews
 * the company at the SoS, tied to formation — NOT the EIN. Rules:
 *   FL → following May 1, DE → following June 1, WY → anniversary month
 *   (all in formation_year + 1); NM/other → none. Idempotent.
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

import { applyStateAnnualReportDate } from "@/lib/operations/formation-renewal-dates"

beforeEach(() => {
  fixtures.account = null
  delete recorded.update
})

describe("applyStateAnnualReportDate — derived from formation_date", () => {
  it("FL → following May 1 (formation year + 1)", async () => {
    fixtures.account = { annual_report_due_date: null, state_of_formation: "Florida", formation_date: "2026-03-10" }
    const notes = await applyStateAnnualReportDate("a")
    expect(recorded.update?.annual_report_due_date).toBe("2027-05-01")
    expect(notes.join(" ")).toContain("Annual-report date set")
  })

  it("DE → following June 1 (uses the actual formation year, not 'now')", async () => {
    fixtures.account = { annual_report_due_date: null, state_of_formation: "Delaware", formation_date: "2024-11-02" }
    await applyStateAnnualReportDate("a")
    expect(recorded.update?.annual_report_due_date).toBe("2025-06-01")
  })

  it("WY → anniversary month, year after formation", async () => {
    fixtures.account = { annual_report_due_date: null, state_of_formation: "Wyoming", formation_date: "2026-07-22" }
    await applyStateAnnualReportDate("a")
    expect(recorded.update?.annual_report_due_date).toBe("2027-07-01")
  })

  it("NM → no annual report (no write)", async () => {
    fixtures.account = { annual_report_due_date: null, state_of_formation: "New Mexico", formation_date: "2026-01-15" }
    const notes = await applyStateAnnualReportDate("a")
    expect(recorded.update).toBeUndefined()
    expect(notes).toHaveLength(0)
  })

  it("already set → preserved (no write)", async () => {
    fixtures.account = { annual_report_due_date: "2030-05-01", state_of_formation: "FL", formation_date: "2026-03-10" }
    const notes = await applyStateAnnualReportDate("a")
    expect(recorded.update).toBeUndefined()
    expect(notes).toHaveLength(0)
  })

  it("no formation_date yet → skipped, no write, no throw", async () => {
    fixtures.account = { annual_report_due_date: null, state_of_formation: "FL", formation_date: null }
    const notes = await applyStateAnnualReportDate("a")
    expect(recorded.update).toBeUndefined()
    expect(notes.join(" ")).toContain("no formation_date")
  })

  it("missing account → no-op", async () => {
    fixtures.account = null
    const notes = await applyStateAnnualReportDate("a")
    expect(recorded.update).toBeUndefined()
    expect(notes).toHaveLength(0)
  })
})
