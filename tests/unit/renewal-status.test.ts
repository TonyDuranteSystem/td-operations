import { describe, it, expect } from "vitest"
import { computeRenewalStatus, type RenewalStatusInput } from "@/lib/operations/renewal-status"

/**
 * Exhaustive status-path matrix for the Renewal Status Engine (plan 89c951a7).
 * Every scenario from the council-hardened spec has a named case; the
 * precedence order (not_applicable > renewed > on_hold_unpaid > overdue >
 * upcoming > missing_data) is pinned by collision cases.
 */

const TODAY = "2026-08-06"

function base(over: Partial<RenewalStatusInput["account"]> = {}, rest: Partial<RenewalStatusInput> = {}): RenewalStatusInput {
  return {
    account: {
      id: "acc-1",
      company_name: "QA Engine LLC",
      account_type: "Client",
      status: "Active",
      state_of_formation: "Wyoming",
      formation_date: "2024-08-10",
      ra_renewal_date: null,
      annual_report_due_date: null,
      is_test: false,
      is_internal: false,
      ...over,
    },
    classification: { category: "active_client" },
    renewalSDs: [],
    overduePayments: [],
    hasActiveClosure: false,
    today: TODAY,
    ...rest,
  }
}

describe("renewed / upcoming / overdue basics", () => {
  it("future date beyond window → renewed", () => {
    const r = computeRenewalStatus(base({ ra_renewal_date: "2027-08-10", annual_report_due_date: "2027-08-01" }))
    expect(r.ra.status).toBe("renewed")
    expect(r.annualReport.status).toBe("renewed")
  })

  it("date inside the 30-day window → upcoming", () => {
    const r = computeRenewalStatus(base({ ra_renewal_date: "2026-08-20" }))
    expect(r.ra.status).toBe("upcoming")
  })

  it("window boundary: exactly today+30 is upcoming; +31 is renewed", () => {
    expect(computeRenewalStatus(base({ ra_renewal_date: "2026-09-05" })).ra.status).toBe("upcoming")
    expect(computeRenewalStatus(base({ ra_renewal_date: "2026-09-06" })).ra.status).toBe("renewed")
  })

  it("past date, no completed SD → overdue with 'verify whether it was done' cause", () => {
    const r = computeRenewalStatus(base({ ra_renewal_date: "2025-11-07" }))
    expect(r.ra.status).toBe("overdue")
    expect(r.ra.cause).toContain("verify")
  })

  it("past date WITH a completed SD for the cycle → overdue with 'record never rolled' cause (TITAN class)", () => {
    const r = computeRenewalStatus(base({ ra_renewal_date: "2025-11-07" }, {
      renewalSDs: [{ id: "sd-1", service_type: "State RA Renewal", status: "completed", due_date: "2025-11-07" }],
    }))
    expect(r.ra.status).toBe("overdue")
    expect(r.ra.cause).toContain("never rolled")
    expect(r.ra.evidence.completedSdForCurrentCycle).toBe(true)
    expect(r.ra.evidence.sdIds).toEqual(["sd-1"])
  })
})

describe("money gate (SOP v7.1 — Antonio ruling a)", () => {
  const pay = [{ id: "pay-1", amount: 1250, currency: "USD", status: "Overdue", due_date: "2026-06-01" }]

  it("due within window + overdue invoice → on_hold_unpaid with amount in cause and ids in evidence", () => {
    const r = computeRenewalStatus(base({ ra_renewal_date: "2026-08-20" }, { overduePayments: pay }))
    expect(r.ra.status).toBe("on_hold_unpaid")
    expect(r.ra.cause).toContain("1250")
    expect(r.ra.evidence.paymentIds).toEqual(["pay-1"])
  })

  it("past date + overdue invoice → on_hold_unpaid wins over overdue (precedence)", () => {
    const r = computeRenewalStatus(base({ ra_renewal_date: "2026-05-03" }, { overduePayments: pay }))
    expect(r.ra.status).toBe("on_hold_unpaid")
    expect(r.ra.cause).toContain("overdue")
  })

  it("future date + overdue invoice → still renewed (gate only fires when due)", () => {
    const r = computeRenewalStatus(base({ ra_renewal_date: "2027-08-10" }, { overduePayments: pay }))
    expect(r.ra.status).toBe("renewed")
  })

  it("missing date + overdue invoice → missing_data (data problem outranks the gate on a date-less row)", () => {
    const r = computeRenewalStatus(base({ ra_renewal_date: null }, { overduePayments: pay }))
    expect(r.ra.status).toBe("missing_data")
  })
})

describe("not_applicable rules", () => {
  it("New Mexico: annual report not applicable, RA still evaluated", () => {
    const r = computeRenewalStatus(base({ state_of_formation: "New Mexico", ra_renewal_date: "2027-06-16" }))
    expect(r.annualReport.status).toBe("not_applicable")
    expect(r.ra.status).toBe("renewed")
  })

  it("'NM' short code behaves identically to 'New Mexico' (one normalizer)", () => {
    const r = computeRenewalStatus(base({ state_of_formation: "NM" }))
    expect(r.annualReport.status).toBe("not_applicable")
  })

  it("One-Time customer: both obligations not_applicable and off the calendar (ruling b)", () => {
    const r = computeRenewalStatus(base({ account_type: "One-Time", ra_renewal_date: "2027-01-20" }, {
      classification: { category: "one_time" },
    }))
    expect(r.onCalendar).toBe(false)
    expect(r.ra.status).toBe("not_applicable")
    expect(r.annualReport.status).toBe("not_applicable")
  })

  it("date NULL + cancelled SD of the type → not_applicable (recorded discontinuation)", () => {
    const r = computeRenewalStatus(base({ ra_renewal_date: null }, {
      renewalSDs: [{ id: "sd-c", service_type: "State RA Renewal", status: "cancelled", due_date: null }],
    }))
    expect(r.ra.status).toBe("not_applicable")
    expect(r.ra.cause).toContain("discontinued")
  })

  it("PAST date + cancelled SD → still overdue, cancellation does not silence a dated obligation", () => {
    const r = computeRenewalStatus(base({ ra_renewal_date: "2025-06-06" }, {
      renewalSDs: [{ id: "sd-c", service_type: "State RA Renewal", status: "cancelled", due_date: null }],
    }))
    expect(r.ra.status).toBe("overdue")
  })
})

describe("missing_data and unknown state", () => {
  it("date NULL, applicable, no cancellation → missing_data with invisibility warning", () => {
    const r = computeRenewalStatus(base())
    expect(r.ra.status).toBe("missing_data")
    expect(r.ra.cause).toContain("invisible")
  })

  it("state NULL → annual report is missing_data with explicit fix-the-state cause, never a silent default", () => {
    const r = computeRenewalStatus(base({ state_of_formation: null }))
    expect(r.annualReport.status).toBe("missing_data")
    expect(r.annualReport.cause).toContain("State of formation")
  })
})

describe("roster and visibility flags", () => {
  it("test/internal accounts are off the calendar", () => {
    expect(computeRenewalStatus(base({ is_test: true })).onCalendar).toBe(false)
    expect(computeRenewalStatus(base({ is_internal: true })).onCalendar).toBe(false)
  })

  it("Suspended account is off the calendar (needs its own surface)", () => {
    expect(computeRenewalStatus(base({ status: "Suspended" })).onCalendar).toBe(false)
  })

  it("closing flag carried when a closure flow is active (ruling c: visible until closure completes)", () => {
    const r = computeRenewalStatus(base({ ra_renewal_date: "2027-01-01" }, { hasActiveClosure: true }))
    expect(r.closing).toBe(true)
    expect(r.onCalendar).toBe(true)
  })
})

describe("SD cycle corroboration is bounded (date-primary — counselor blocker)", () => {
  it("a completed SD from an OLD cycle does not corroborate the current one", () => {
    const r = computeRenewalStatus(base({ ra_renewal_date: "2026-11-07" }, {
      renewalSDs: [{ id: "sd-old", service_type: "State RA Renewal", status: "completed", due_date: "2024-11-07" }],
    }))
    expect(r.ra.evidence.completedSdForCurrentCycle).toBe(false)
  })

  it("BLOCKER REGRESSION: LAST year's filing (due exactly the previous anniversary) never corroborates THIS year's missed one", () => {
    // Correctly-rolled record goes overdue; the prior cycle's completed SD
    // sits at exactly the previous anniversary — the cron's default shape.
    // Corroborating it would launder a missed filing into a "record repair".
    const r = computeRenewalStatus(base({ ra_renewal_date: "2026-11-07" }, {
      today: "2026-11-08",
      renewalSDs: [{ id: "sd-prev", service_type: "State RA Renewal", status: "completed", due_date: "2025-11-07" }],
    }))
    expect(r.ra.evidence.completedSdForCurrentCycle).toBe(false)
    expect(r.ra.status).toBe("overdue")
    expect(r.ra.cause).toContain("verify")
  })

  it("corroborated stale record + unrelated overdue invoice → still the record-repair verdict, NOT an unpaid hold", () => {
    // Nothing is being withheld — the renewal was already performed; a €150
    // stray invoice must not gate the pure record fix behind a money decision.
    const r = computeRenewalStatus(base({ ra_renewal_date: "2025-11-07" }, {
      renewalSDs: [{ id: "sd-1", service_type: "State RA Renewal", status: "completed", due_date: "2025-11-07" }],
      overduePayments: [{ id: "p-x", amount: 150, currency: "EUR", status: "Overdue", due_date: "2026-06-01" }],
    }))
    expect(r.ra.status).toBe("overdue")
    expect(r.ra.cause).toContain("never rolled")
  })

  it("historical cancelled SD does NOT silence a re-engaged service (active SD present, date NULL → missing_data)", () => {
    const r = computeRenewalStatus(base({ ra_renewal_date: null }, {
      renewalSDs: [
        { id: "sd-old", service_type: "State RA Renewal", status: "cancelled", due_date: null },
        { id: "sd-new", service_type: "State RA Renewal", status: "active", due_date: null },
      ],
    }))
    expect(r.ra.status).toBe("missing_data")
  })

  it("completed SD with NULL due_date never corroborates (attribution requires a date)", () => {
    const r = computeRenewalStatus(base({ ra_renewal_date: "2025-11-07" }, {
      renewalSDs: [{ id: "sd-n", service_type: "State RA Renewal", status: "completed", due_date: null }],
    }))
    expect(r.ra.evidence.completedSdForCurrentCycle).toBe(false)
    expect(r.ra.status).toBe("overdue")
  })

  it("duplicate completed SDs are tolerated — evidence lists both, status unchanged", () => {
    const r = computeRenewalStatus(base({ ra_renewal_date: "2025-11-07" }, {
      renewalSDs: [
        { id: "sd-1", service_type: "State RA Renewal", status: "completed", due_date: "2025-11-07" },
        { id: "sd-2", service_type: "State RA Renewal", status: "completed", due_date: "2025-11-07" },
      ],
    }))
    expect(r.ra.evidence.sdIds).toHaveLength(2)
    expect(r.ra.status).toBe("overdue")
  })
})

describe("real replay anchors (Luca's 2026-08-06 file)", () => {
  it("TITAN: both dates 2025-11-07, 2026 paid, SDs queued → both overdue with record-never-rolled cause", () => {
    const r = computeRenewalStatus(base(
      { company_name: "TITAN REAL ESTATE GROUP LLC", ra_renewal_date: "2025-11-07", annual_report_due_date: "2025-11-07", formation_date: "2024-11-07" },
      {
        renewalSDs: [
          { id: "s1", service_type: "State RA Renewal", status: "active", due_date: "2026-11-07" },
          { id: "s2", service_type: "State Annual Report", status: "active", due_date: "2026-11-07" },
        ],
      },
    ))
    expect(r.ra.status).toBe("overdue")
    expect(r.annualReport.status).toBe("overdue")
    expect(r.onCalendar).toBe(true) // visible regardless of the year being viewed
  })

  it("Sese-class: past dates + unpaid installments → on_hold_unpaid, not bare overdue", () => {
    const r = computeRenewalStatus(base(
      { company_name: "Sese Marketing LLC", state_of_formation: "Florida", ra_renewal_date: "2026-07-03", annual_report_due_date: "2026-05-01" },
      { overduePayments: [
        { id: "p1", amount: 849, currency: "USD", status: "Overdue", due_date: "2026-01-31" },
        { id: "p2", amount: 849, currency: "USD", status: "Overdue", due_date: "2026-06-01" },
      ] },
    ))
    expect(r.ra.status).toBe("on_hold_unpaid")
    expect(r.annualReport.status).toBe("on_hold_unpaid")
    expect(r.ra.evidence.paymentIds).toEqual(["p1", "p2"])
  })

  it("new NM formation with no dates yet → RA missing_data, AR not_applicable", () => {
    const r = computeRenewalStatus(base({ company_name: "BRIXEL LLC", state_of_formation: "New Mexico", formation_date: "2026-07-13" }))
    expect(r.ra.status).toBe("missing_data")
    expect(r.annualReport.status).toBe("not_applicable")
  })
})
