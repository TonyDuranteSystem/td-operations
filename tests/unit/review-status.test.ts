import { describe, it, expect } from "vitest"
import {
  canTransition,
  isClientEditable,
  advancesServiceDelivery,
  buildReviewHistoryEntry,
  isReviewStatus,
  REVIEW_STATUSES,
} from "@/lib/tax/review-status"

describe("review-status: canTransition (spec §3 graph)", () => {
  it("first submit: null → submitted is legal", () => {
    expect(canTransition(null, "submitted")).toBe(true)
  })
  it("null → anything-but-submitted is illegal", () => {
    expect(canTransition(null, "under_review")).toBe(false)
    expect(canTransition(null, "confirmed")).toBe(false)
  })
  it("happy path: submitted → under_review → approved → confirmed", () => {
    expect(canTransition("submitted", "under_review")).toBe(true)
    expect(canTransition("under_review", "approved")).toBe(true)
    expect(canTransition("approved", "confirmed")).toBe(true)
  })
  it("revision loop: under_review → revision_requested → resubmitted → under_review", () => {
    expect(canTransition("under_review", "revision_requested")).toBe(true)
    expect(canTransition("revision_requested", "resubmitted")).toBe(true)
    expect(canTransition("resubmitted", "under_review")).toBe(true)
  })
  it("approved can bounce back to revision_requested", () => {
    expect(canTransition("approved", "revision_requested")).toBe(true)
  })
  it("staff can request changes from any non-confirmed state (Carasso edit-button fix)", () => {
    // Legacy external-form submissions carry review_status = null; the flow
    // "Request Changes" button must reach revision_requested from there and from
    // every other pre-confirmation state.
    expect(canTransition(null, "revision_requested")).toBe(true)
    expect(canTransition("submitted", "revision_requested")).toBe(true)
    expect(canTransition("resubmitted", "revision_requested")).toBe(true)
    expect(canTransition("reopened", "revision_requested")).toBe(true)
  })
  it("a confirmed (finalized) return still cannot jump straight to revision_requested", () => {
    expect(canTransition("confirmed", "revision_requested")).toBe(false)
  })
  it("reopen: confirmed → reopened → submitted", () => {
    expect(canTransition("confirmed", "reopened")).toBe(true)
    expect(canTransition("reopened", "submitted")).toBe(true)
  })
  it("rejects illegal jumps", () => {
    expect(canTransition("submitted", "confirmed")).toBe(false) // can't skip review
    expect(canTransition("submitted", "approved")).toBe(false)
    expect(canTransition("confirmed", "submitted")).toBe(false) // must go via reopened
    expect(canTransition("revision_requested", "under_review")).toBe(false) // must resubmit first
    expect(canTransition("confirmed", "confirmed")).toBe(false)
  })
})

describe("review-status: isClientEditable (replaces sent_to_accountant lock)", () => {
  it("editable before submission exists", () => {
    expect(isClientEditable(null)).toBe(true)
  })
  it("editable at submitted / resubmitted / revision_requested / approved / reopened (Edit states)", () => {
    expect(isClientEditable("submitted")).toBe(true)
    expect(isClientEditable("resubmitted")).toBe(true)
    expect(isClientEditable("revision_requested")).toBe(true)
    expect(isClientEditable("approved")).toBe(true)
    expect(isClientEditable("reopened")).toBe(true) // staff reopened → client can edit again
  })

  // THE FREEZE (2026-08-03). `resubmitted` was missing from the editable set
  // since the original Slices 1-3 commit, which locked five accounts out of the
  // whole tax-financials screen AND their wizard — every write route 409'd, so
  // the categorization step we were chasing them to finish was impossible.
  // Economicamente (765 items) and Imperium (2 items) both reported it as "the
  // system does nothing". Pinned separately from the list above so a reverting
  // edit fails with a test name that says exactly what breaks.
  it("resubmitted is EDITABLE — the client handed data back, no staff review has started", () => {
    expect(isClientEditable("resubmitted")).toBe(true)
  })

  it("locked while staff reviewing and after confirm", () => {
    expect(isClientEditable("under_review")).toBe(false)
    expect(isClientEditable("confirmed")).toBe(false)
  })

  // The guard that actually matters must survive the fix above: the ONLY way
  // out of resubmitted toward staff work is under_review, which is locked.
  it("the resubmitted → under_review transition still closes the door", () => {
    expect(isClientEditable("resubmitted")).toBe(true)
    expect(isClientEditable("under_review")).toBe(false)
  })
})

describe("review-status: advancesServiceDelivery", () => {
  it("only confirmed releases the SD from the review block", () => {
    expect(advancesServiceDelivery("confirmed")).toBe(true)
    for (const s of REVIEW_STATUSES.filter(s => s !== "confirmed")) {
      expect(advancesServiceDelivery(s)).toBe(false)
    }
  })
})

describe("review-status: buildReviewHistoryEntry", () => {
  it("stamps the correct actor for the target status", () => {
    const e = buildReviewHistoryEntry({ from: "under_review", to: "approved", at: "2026-06-09T00:00:00Z", by: "Luca" })
    expect(e.actor).toBe("staff")
    expect(e).toMatchObject({ from: "under_review", to: "approved", by: "Luca" })
  })
  it("client transitions are tagged client", () => {
    const e = buildReviewHistoryEntry({ from: "approved", to: "confirmed", at: "2026-06-09T00:00:00Z", by: "client:uuid" })
    expect(e.actor).toBe("client")
  })
  it("trims a note and omits an empty one", () => {
    const withNote = buildReviewHistoryEntry({ from: "under_review", to: "revision_requested", at: "t", by: "Luca", note: "  fix revenue total  " })
    expect(withNote.note).toBe("fix revenue total")
    const noNote = buildReviewHistoryEntry({ from: "under_review", to: "revision_requested", at: "t", by: "Luca", note: "   " })
    expect(noNote.note).toBeUndefined()
  })
})

describe("review-status: isReviewStatus", () => {
  it("accepts the 7 valid statuses, rejects junk", () => {
    for (const s of REVIEW_STATUSES) expect(isReviewStatus(s)).toBe(true)
    expect(isReviewStatus("reviewed")).toBe(false) // legacy submission.status value, NOT a review_status
    expect(isReviewStatus(null)).toBe(false)
    expect(isReviewStatus(undefined)).toBe(false)
  })
})
