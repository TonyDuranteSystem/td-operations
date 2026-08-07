import { describe, it, expect } from "vitest"
import { computeRenewalStatus, type RenewalStatusInput } from "@/lib/operations/renewal-status"
import { proposeRenewalFixes } from "@/lib/operations/renewal-problem-proposals"
import type { LoadedRenewalAccount, RenewalAccountRow } from "@/lib/operations/renewal-status-loader"

/**
 * Proposal-layer matrix: every problem status maps to exactly one action +
 * tier, auto-fixes carry ABSOLUTE from→to values, and non-corroborated /
 * money cases never get a one-click fix.
 */

const TODAY = "2026-08-06"

function loaded(
  accountOver: Partial<RenewalAccountRow> = {},
  inputOver: Partial<RenewalStatusInput> = {},
  intake: LoadedRenewalAccount["intake"] = "formation",
): LoadedRenewalAccount {
  const account: RenewalAccountRow = {
    id: "acc-1",
    company_name: "Proposal QA LLC",
    account_type: "Client",
    status: "Active",
    state_of_formation: "Wyoming",
    formation_date: "2024-08-10",
    ra_renewal_date: null,
    annual_report_due_date: null,
    is_test: false,
    is_internal: false,
    ein_number: "12-3456789",
    entity_type: "Single Member LLC",
    ra_switch_date: null,
    client_since: null,
    registered_agent_id: null,
    registered_agent_provider: null,
    registered_agent_address: null,
    gdrive_folder_url: null,
    drive_folder_id: null,
    portal_tier: "active",
    ...accountOver,
  }
  const status = computeRenewalStatus({
    account,
    classification: { category: "active_client" },
    renewalSDs: [],
    overduePayments: [],
    hasActiveClosure: false,
    today: TODAY,
    ...inputOver,
  })
  return { account, status, intake }
}

describe("proposeRenewalFixes", () => {
  it("TITAN class: corroborated stale record → safe one-click roll with absolute from→to", () => {
    const l = loaded(
      { ra_renewal_date: "2025-11-07", annual_report_due_date: "2027-11-07" },
      { renewalSDs: [{ id: "sd-1", service_type: "State RA Renewal", status: "completed", due_date: "2025-11-07" }] },
    )
    const props = proposeRenewalFixes(l, { today: TODAY })
    expect(props).toHaveLength(1)
    expect(props[0]).toMatchObject({
      obligation: "ra_renewal",
      action: "roll_forward_date",
      tier: "safe",
      autoFix: { column: "ra_renewal_date", from: "2025-11-07", to: "2026-11-07" },
    })
    expect(props[0].details).toContain("no state filing and no client contact")
  })

  it("uncorroborated overdue → verify_filing, confirm tier, NO auto-fix", () => {
    const l = loaded({ ra_renewal_date: "2025-11-07", annual_report_due_date: "2027-11-07" })
    const props = proposeRenewalFixes(l, { today: TODAY })
    expect(props).toHaveLength(1)
    expect(props[0].action).toBe("verify_filing")
    expect(props[0].tier).toBe("confirm")
    expect(props[0].autoFix).toBeNull()
    expect(props[0].details).toContain("do not just change the date")
  })

  it("unpaid hold → review_unpaid, antonio_only, NO auto-fix (money is never one-click)", () => {
    const l = loaded(
      { ra_renewal_date: "2026-08-20", annual_report_due_date: "2027-11-07" },
      { overduePayments: [{ id: "p-1", amount: 849, currency: "EUR", status: "Overdue", due_date: "2026-06-01" }] },
    )
    const props = proposeRenewalFixes(l, { today: TODAY })
    expect(props).toHaveLength(1)
    expect(props[0]).toMatchObject({ action: "review_unpaid", tier: "antonio_only", autoFix: null })
    expect(props[0].details).toContain("Antonio decides")
  })

  it("missing RA date, formation intake → derive from formation anniversary (from: null)", () => {
    const l = loaded({ annual_report_due_date: "2027-08-01" })
    const props = proposeRenewalFixes(l, { today: TODAY })
    expect(props).toHaveLength(1)
    expect(props[0]).toMatchObject({
      obligation: "ra_renewal",
      action: "derive_missing_date",
      tier: "confirm",
      autoFix: { column: "ra_renewal_date", from: null, to: "2025-08-10" },
    })
  })

  it("missing RA date, onboarding intake → derive from ra_switch_date", () => {
    const l = loaded(
      { annual_report_due_date: "2027-08-01", formation_date: "2020-01-15", ra_switch_date: "2026-03-01" },
      {},
      "onboarding",
    )
    const props = proposeRenewalFixes(l, { today: TODAY })
    expect(props[0].autoFix).toEqual({ column: "ra_renewal_date", from: null, to: "2027-03-01" })
    expect(props[0].details).toContain("RA-switch date")
  })

  it("missing date, unknown intake → fix_account_fields manual, NO auto-fix", () => {
    const l = loaded({ annual_report_due_date: "2027-08-01", formation_date: null }, {}, null)
    const props = proposeRenewalFixes(l, { today: TODAY })
    expect(props[0].action).toBe("fix_account_fields")
    expect(props[0].autoFix).toBeNull()
  })

  it("missing AR date, WY formation intake → derives formation-month AR for next year", () => {
    const l = loaded({ ra_renewal_date: "2027-08-10" })
    const props = proposeRenewalFixes(l, { today: TODAY })
    expect(props).toHaveLength(1)
    expect(props[0]).toMatchObject({
      obligation: "annual_report",
      autoFix: { column: "annual_report_due_date", from: null, to: "2027-08-01" },
    })
  })

  it("healthy company → no cards; off-calendar company → no cards even with problems", () => {
    const healthy = loaded({ ra_renewal_date: "2027-08-10", annual_report_due_date: "2027-08-01" })
    expect(proposeRenewalFixes(healthy, { today: TODAY })).toEqual([])

    const oneTime = loaded(
      { account_type: "One-Time", ra_renewal_date: "2025-01-01" },
      { classification: { category: "one_time" } },
    )
    expect(proposeRenewalFixes(oneTime, { today: TODAY })).toEqual([])
  })

  it("closing company keeps its cards with the closure note (ruling c)", () => {
    const l = loaded(
      { ra_renewal_date: "2025-11-07", annual_report_due_date: "2027-11-07" },
      { hasActiveClosure: true },
    )
    const props = proposeRenewalFixes(l, { today: TODAY })
    expect(props).toHaveLength(1)
    expect(props[0].details).toContain("active closure")
  })

  it("both obligations broken → two cards, independently diagnosed", () => {
    const l = loaded(
      { ra_renewal_date: "2025-11-07", annual_report_due_date: null },
      { renewalSDs: [{ id: "sd-1", service_type: "State RA Renewal", status: "completed", due_date: "2025-11-07" }] },
    )
    const props = proposeRenewalFixes(l, { today: TODAY })
    expect(props.map(p => [p.obligation, p.action])).toEqual([
      ["ra_renewal", "roll_forward_date"],
      ["annual_report", "derive_missing_date"],
    ])
  })
})
