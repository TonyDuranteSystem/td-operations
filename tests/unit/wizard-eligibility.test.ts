/**
 * Tax Wizard Eligibility resolver — pure decision core (PTBT incident,
 * dev job 8cc8e1c8). Every rule the council pinned gets a test:
 * open-row token, strict formation direction, named stage allow-lists
 * (fail-closed), per-target-year review precedence, next-season unlock,
 * and the locked-view surface rule.
 */

import { describe, it, expect } from "vitest"
import {
  decideTaxWizardEligibility,
  taxWizardSurfaceVisible,
  CLOSED_REASON_COPY,
  type TaxWizardEligibilityInputs,
  type TaxWizardClosedReason,
} from "@/lib/tax/wizard-eligibility"

function inputs(partial: Partial<TaxWizardEligibilityInputs>): TaxWizardEligibilityInputs {
  return {
    sds: [{ service_type: "Tax Return", stage: "Wizard Available" }],
    openReturns: [{ id: "tr-1", tax_year: 2025 }],
    submissions: [],
    formationDate: "2023-05-01",
    accountless: false,
    ...partial,
  }
}

function sub(over: Partial<{ id: string; tax_year: number; review_status: string | null; created_at: string }>) {
  return { id: "sub-1", tax_year: 2025, review_status: "submitted", created_at: "2026-06-01T00:00:00Z", ...over }
}

describe("decideTaxWizardEligibility — open mode", () => {
  it("opens with an open row + Wizard Available stage, pinning year and row id", () => {
    const r = decideTaxWizardEligibility(inputs({}))
    expect(r).toEqual({ mode: "open", taxYear: 2025, taxReturnId: "tr-1", submissionId: null, reason: null })
  })

  it("closes with no active tax SD at all", () => {
    const r = decideTaxWizardEligibility(inputs({ sds: [] }))
    expect(r.mode).toBe("closed")
    expect(r.reason).toBe("no_tax_service")
  })

  it("closes with no open tax_returns row — the season is not open (PTBT core case)", () => {
    const r = decideTaxWizardEligibility(inputs({ openReturns: [] }))
    expect(r.mode).toBe("closed")
    expect(r.reason).toBe("no_tax_return_open")
    expect(r.taxYear).toBeNull()
  })

  it("closes at a pre-wizard stage (1st Installment Paid — PTBT's actual stage)", () => {
    const r = decideTaxWizardEligibility(inputs({ sds: [{ service_type: "Tax Return", stage: "1st Installment Paid" }] }))
    expect(r.mode).toBe("closed")
    expect(r.reason).toBe("pre_wizard_stage")
  })

  it("fails CLOSED on a NULL stage", () => {
    const r = decideTaxWizardEligibility(inputs({ sds: [{ service_type: "Tax Return", stage: null }] }))
    expect(r.reason).toBe("pre_wizard_stage")
  })

  it("fails CLOSED on an unknown/renamed stage (the old deny-list let these through)", () => {
    const r = decideTaxWizardEligibility(inputs({ sds: [{ service_type: "Tax Return", stage: "Some Future Stage" }] }))
    expect(r.reason).toBe("pre_wizard_stage")
  })

  it("does NOT treat the review-block stage as open (SD parks at Data Submitted mid-review)", () => {
    // No submission exists (e.g. staff deleted it): stage 45 alone must not re-open.
    const r = decideTaxWizardEligibility(inputs({ sds: [{ service_type: "Tax Return", stage: "Data Submitted" }] }))
    expect(r.reason).toBe("pre_wizard_stage")
  })

  it("gates by stage NAME per service type, not order: One-Time opens at Payment Received", () => {
    const r = decideTaxWizardEligibility(inputs({ sds: [{ service_type: "Tax Return One-Time", stage: "Payment Received" }] }))
    expect(r.mode).toBe("open")
  })

  it("One-Time stays closed pre-payment", () => {
    const r = decideTaxWizardEligibility(inputs({ sds: [{ service_type: "Tax Return One-Time", stage: "Payment Pending" }] }))
    expect(r.reason).toBe("pre_wizard_stage")
  })

  it("bundle 'Payment Received' (a One-Time-only stage name) does NOT open the bundle wizard", () => {
    const r = decideTaxWizardEligibility(inputs({ sds: [{ service_type: "Tax Return", stage: "Payment Received" }] }))
    expect(r.reason).toBe("pre_wizard_stage")
  })
})

describe("decideTaxWizardEligibility — formation-year guard (strict direction)", () => {
  it("closes when the company was formed AFTER the tax year (PTBT: formed 2026, open row 2025)", () => {
    const r = decideTaxWizardEligibility(inputs({ formationDate: "2026-03-02" }))
    expect(r.mode).toBe("closed")
    expect(r.reason).toBe("formation_after_tax_year")
  })

  it("opens when formed IN the tax year (first-year filer)", () => {
    const r = decideTaxWizardEligibility(inputs({ formationDate: "2025-07-15" }))
    expect(r.mode).toBe("open")
  })

  it("opens when formed before the tax year", () => {
    const r = decideTaxWizardEligibility(inputs({ formationDate: "2020-01-01" }))
    expect(r.mode).toBe("open")
  })

  it("NULL formation_date passes — staff's deliberately-opened row is the stronger signal", () => {
    const r = decideTaxWizardEligibility(inputs({ formationDate: null }))
    expect(r.mode).toBe("open")
  })
})

describe("decideTaxWizardEligibility — review loop", () => {
  it.each(["submitted", "revision_requested", "approved", "reopened"] as const)(
    "client-editable status %s → review mode pinned to the submission",
    (status) => {
      const r = decideTaxWizardEligibility(inputs({ submissions: [sub({ review_status: status })] }))
      expect(r.mode).toBe("review")
      expect(r.taxYear).toBe(2025)
      expect(r.submissionId).toBe("sub-1")
    },
  )

  it("under_review locks (client must not edit while staff review)", () => {
    const r = decideTaxWizardEligibility(inputs({ submissions: [sub({ review_status: "under_review" })] }))
    expect(r.mode).toBe("closed")
    expect(r.reason).toBe("under_review")
  })

  it("resubmitted locks (staff round in flight)", () => {
    const r = decideTaxWizardEligibility(inputs({ submissions: [sub({ review_status: "resubmitted" })] }))
    expect(r.reason).toBe("under_review")
  })

  it("confirmed locks with its own reason", () => {
    const r = decideTaxWizardEligibility(inputs({ submissions: [sub({ review_status: "confirmed" })] }))
    expect(r.reason).toBe("confirmed")
  })

  it("review mode works with NO open row (data_received flipped mid-review — the 9 live clients)", () => {
    const r = decideTaxWizardEligibility(inputs({
      openReturns: [],
      sds: [{ service_type: "Tax Return", stage: "Data Submitted" }],
      submissions: [sub({ review_status: "revision_requested" })],
    }))
    expect(r.mode).toBe("review")
    expect(r.submissionId).toBe("sub-1")
    expect(r.taxYear).toBe(2025)
  })

  it("legacy NULL review_status with no open row → closed (edits go through staff)", () => {
    const r = decideTaxWizardEligibility(inputs({
      openReturns: [],
      submissions: [sub({ review_status: null })],
    }))
    expect(r.mode).toBe("closed")
    expect(r.reason).toBe("no_tax_return_open")
  })

  it("legacy NULL review_status WITH an open row falls through to open (fresh submit supersedes)", () => {
    const r = decideTaxWizardEligibility(inputs({ submissions: [sub({ review_status: null })] }))
    expect(r.mode).toBe("open")
  })

  it("latest submission FOR THE TARGET YEAR wins when several exist", () => {
    const r = decideTaxWizardEligibility(inputs({
      submissions: [
        sub({ id: "old", review_status: "confirmed", created_at: "2026-03-01T00:00:00Z" }),
        sub({ id: "new", review_status: "revision_requested", created_at: "2026-06-15T00:00:00Z" }),
      ],
    }))
    expect(r.mode).toBe("review")
    expect(r.submissionId).toBe("new")
  })
})

describe("decideTaxWizardEligibility — next-season unlock", () => {
  it("a NEWER open year outranks an older year's lingering editable submission", () => {
    // 2025 submission never confirmed (approved); 2026 season opens.
    const r = decideTaxWizardEligibility(inputs({
      openReturns: [{ id: "tr-2026", tax_year: 2026 }],
      submissions: [sub({ tax_year: 2025, review_status: "approved" })],
    }))
    expect(r.mode).toBe("open")
    expect(r.taxYear).toBe(2026)
    expect(r.taxReturnId).toBe("tr-2026")
  })

  it("multi-open-year: the OLDEST open year is collected first (back-filing)", () => {
    const r = decideTaxWizardEligibility(inputs({
      openReturns: [
        { id: "tr-2025", tax_year: 2025 },
        { id: "tr-2024", tax_year: 2024 },
      ],
    }))
    expect(r.taxYear).toBe(2024)
    expect(r.taxReturnId).toBe("tr-2024")
  })

  it("review of the target year still outranks a second open year", () => {
    const r = decideTaxWizardEligibility(inputs({
      openReturns: [
        { id: "tr-2024", tax_year: 2024 },
        { id: "tr-2025", tax_year: 2025 },
      ],
      submissions: [sub({ tax_year: 2024, review_status: "revision_requested" })],
    }))
    expect(r.mode).toBe("review")
    expect(r.taxYear).toBe(2024)
  })
})

describe("decideTaxWizardEligibility — company_info intake", () => {
  it("contact-scoped (accountless) tax SD routes to company_info, never locked out", () => {
    const r = decideTaxWizardEligibility(inputs({
      accountless: true,
      openReturns: [],
      sds: [{ service_type: "Tax Return", stage: "Company Data Pending" }],
    }))
    expect(r.mode).toBe("company_info")
  })

  it("account-scoped SD at Company Data Pending also routes to company_info", () => {
    const r = decideTaxWizardEligibility(inputs({
      sds: [{ service_type: "Tax Return", stage: "Company Data Pending" }],
    }))
    expect(r.mode).toBe("company_info")
  })
})

describe("taxWizardSurfaceVisible — locked states keep the read-only view", () => {
  it.each([
    [{ openReturns: [] as { id: string; tax_year: number }[] }, false],           // no_tax_return_open → hidden
    [{ sds: [{ service_type: "Tax Return", stage: "1st Installment Paid" }] }, false], // pre-wizard → hidden
    [{ submissions: [sub({ review_status: "under_review" })] }, true],            // locked but viewable
    [{ submissions: [sub({ review_status: "confirmed" })] }, true],               // locked but viewable
    [{}, true],                                                                    // open → visible
    [{ submissions: [sub({ review_status: "approved" })] }, true],                 // review → visible
  ])("case %#", (partial, visible) => {
    expect(taxWizardSurfaceVisible(decideTaxWizardEligibility(inputs(partial)))).toBe(visible)
  })
})

describe("CLOSED_REASON_COPY", () => {
  it("carries EN + IT copy for every closed reason", () => {
    const reasons: TaxWizardClosedReason[] = [
      "no_tax_service", "no_tax_return_open", "pre_wizard_stage",
      "formation_after_tax_year", "under_review", "confirmed",
    ]
    for (const r of reasons) {
      expect(CLOSED_REASON_COPY[r].en.length).toBeGreaterThan(10)
      expect(CLOSED_REASON_COPY[r].it.length).toBeGreaterThan(10)
    }
  })
})
