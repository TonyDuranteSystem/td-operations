import { describe, it, expect } from "vitest"
import { decideClosureWhatsNew, shouldReportSwallowedResubmission } from "@/lib/portal/closure-whats-new"

/** Step 5b of closure-form-completed: when to post / re-post / skip the staff What's New note. */
describe("decideClosureWhatsNew", () => {
  it("first portal submission (no prior hash) → plain emit", () => {
    expect(decideClosureWhatsNew({ sdWasNewlyCreated: false, dedupeKey: "h1", priorHash: null, isGenuineChange: true }))
      .toEqual({ action: "emit", retireFirst: false, isResubmission: false })
  })

  it("genuine correction after a processed pass → retire old note, post 'resubmitted'", () => {
    expect(decideClosureWhatsNew({ sdWasNewlyCreated: false, dedupeKey: "h2", priorHash: "h1", isGenuineChange: true }))
      .toEqual({ action: "emit", retireFirst: true, isResubmission: true })
  })

  it("mechanical retry of identical content → plain emit (dedup makes it a no-op), never retires", () => {
    expect(decideClosureWhatsNew({ sdWasNewlyCreated: false, dedupeKey: "h1", priorHash: "h1", isGenuineChange: false }))
      .toEqual({ action: "emit", retireFirst: false, isResubmission: false })
  })

  it("legacy emailed link (no dedupe key) → never treated as a resubmission", () => {
    expect(decideClosureWhatsNew({ sdWasNewlyCreated: false, dedupeKey: null, priorHash: "old", isGenuineChange: true }))
      .toEqual({ action: "emit", retireFirst: false, isResubmission: false })
  })

  it("retry of the submission that CREATED the SD → emit (the marker dedup makes a replay a no-op); never retires", () => {
    expect(decideClosureWhatsNew({ sdWasNewlyCreated: false, sdCreatedFromThisSubmission: true, dedupeKey: "h1", priorHash: "h1", isGenuineChange: false }))
      .toEqual({ action: "emit", retireFirst: false, isResubmission: false })
    expect(decideClosureWhatsNew({ sdWasNewlyCreated: false, sdCreatedFromThisSubmission: true, dedupeKey: null, priorHash: null, isGenuineChange: true }).action).toBe("emit")
  })

  it("genuine CORRECTION of the submission that created the SD → emit as resubmission (council round 3)", () => {
    expect(decideClosureWhatsNew({ sdWasNewlyCreated: false, sdCreatedFromThisSubmission: true, dedupeKey: "h2", priorHash: "h1", isGenuineChange: true }))
      .toEqual({ action: "emit", retireFirst: true, isResubmission: true })
  })

  it("closure SD auto-created by this very submission → still emits (creating a service posts no What's New note any more)", () => {
    expect(decideClosureWhatsNew({ sdWasNewlyCreated: true, dedupeKey: null, priorHash: null, isGenuineChange: true }))
      .toEqual({ action: "emit", retireFirst: false, isResubmission: false })
  })
})

describe("shouldReportSwallowedResubmission", () => {
  const passStartedAt = new Date("2026-09-24T12:00:00Z")
  const base = { retireFirst: true, retiredCount: 0, emitReason: "already_emitted", passStartedAt }

  it("old note could not be retired and still stands (predates this pass) → report", () => {
    expect(shouldReportSwallowedResubmission({ ...base, survivingNoteCreatedAt: "2026-09-20T09:00:00Z" })).toBe(true)
  })

  it("concurrent pass already retired + posted the fresh note during this pass → no false alarm", () => {
    expect(shouldReportSwallowedResubmission({ ...base, survivingNoteCreatedAt: "2026-09-24T12:00:01Z" })).toBe(false)
  })

  it("unknown surviving-note time → report (fail loud)", () => {
    expect(shouldReportSwallowedResubmission({ ...base, survivingNoteCreatedAt: null })).toBe(true)
  })

  it("not a resubmission, retire worked, or a fresh note was posted → never report", () => {
    expect(shouldReportSwallowedResubmission({ ...base, retireFirst: false, survivingNoteCreatedAt: null })).toBe(false)
    expect(shouldReportSwallowedResubmission({ ...base, retiredCount: 1, survivingNoteCreatedAt: null })).toBe(false)
    expect(shouldReportSwallowedResubmission({ ...base, emitReason: undefined, survivingNoteCreatedAt: null })).toBe(false)
  })
})
