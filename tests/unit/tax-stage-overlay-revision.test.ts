import { describe, it, expect } from "vitest"
import { overlayEffectiveStageName, type StageOrderRef } from "@/lib/tax/tax-stage-overlay"

// Real Tax Return catalog stage_orders (verified live: Data Submitted 45,
// Under Review 46, Revision Requested 47, Approved 48, Confirmed 49).
const STAGES: StageOrderRef[] = [
  { stage_name: "Data Submitted", stage_order: 45 },
  { stage_name: "Under Review", stage_order: 46 },
  { stage_name: "Revision Requested", stage_order: 47 },
  { stage_name: "Approved", stage_order: 48 },
  { stage_name: "Confirmed", stage_order: 49 },
]

describe("tax overlay — Carasso edit-button fix: board tracks the review sub-state", () => {
  it("staff requested changes → shows Revision Requested (SD parked at Data Submitted)", () => {
    expect(overlayEffectiveStageName(STAGES, "Data Submitted", "revision_requested")).toBe("Revision Requested")
  })

  it("client RESUBMITTED → board returns to Data Submitted, NOT stuck on Revision Requested", () => {
    // This is the #2 fix: on resubmit the handler now moves the SD off
    // "Revision Requested" back to "Data Submitted" (45), so the overlay — which
    // takes the FURTHER of SD stage and review-mapped stage — no longer pins the
    // card at 47. Before the fix the SD sat at 47 and this returned "Revision
    // Requested" forever.
    expect(overlayEffectiveStageName(STAGES, "Data Submitted", "resubmitted")).toBe("Data Submitted")
  })

  it("staff started re-review → shows Under Review", () => {
    expect(overlayEffectiveStageName(STAGES, "Data Submitted", "under_review")).toBe("Under Review")
  })

  it("REGRESSION GUARD: an SD stranded at Revision Requested WOULD stick (why the handler must move it)", () => {
    // Documents the failure the fix prevents: if the SD were left at 47, a
    // resubmitted card stays on Revision Requested.
    expect(overlayEffectiveStageName(STAGES, "Revision Requested", "resubmitted")).toBe("Revision Requested")
  })
})
