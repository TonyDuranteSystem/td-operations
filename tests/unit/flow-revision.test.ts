import { describe, it, expect } from "vitest"
import { decideFlowRevision } from "@/lib/tax/flow-revision"
import { REVIEW_STATUSES, type ReviewStatus } from "@/lib/tax/review-status"

describe("decideFlowRevision — flow-workspace Request Changes", () => {
  it("no submission → nothing to unlock", () => {
    expect(decideFlowRevision(null, false)).toEqual({ ok: false, reason: "no_submission" })
  })

  it("LEGACY null review_status unlocks (the Carasso / 64-client case)", () => {
    expect(decideFlowRevision(null, true)).toEqual({
      ok: true,
      from: null,
      to: "revision_requested",
    })
  })

  it("unlocks from every non-confirmed, non-revision state", () => {
    for (const from of ["submitted", "under_review", "resubmitted", "approved", "reopened"] as ReviewStatus[]) {
      expect(decideFlowRevision(from, true)).toEqual({ ok: true, from, to: "revision_requested" })
    }
  })

  it("already revision_requested → idempotent no-op (a second press is safe)", () => {
    expect(decideFlowRevision("revision_requested", true)).toEqual({
      ok: false,
      reason: "already_revision_requested",
    })
  })

  it("confirmed is locked — a finalized return must be reopened first", () => {
    expect(decideFlowRevision("confirmed", true)).toEqual({ ok: false, reason: "confirmed_locked" })
  })

  it("every review status resolves to a defined decision (no silent fallthrough)", () => {
    for (const s of [null, ...REVIEW_STATUSES] as (ReviewStatus | null)[]) {
      const d = decideFlowRevision(s, true)
      expect(d).toHaveProperty("ok")
      if (!d.ok) expect(typeof d.reason).toBe("string")
    }
  })
})
