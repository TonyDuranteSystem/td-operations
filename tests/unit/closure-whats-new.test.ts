import { describe, it, expect } from "vitest"
import { decideClosureWhatsNew } from "@/lib/portal/closure-whats-new"

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

  it("closure SD auto-created by this very submission → skip (createSD's own note covers it)", () => {
    expect(decideClosureWhatsNew({ sdWasNewlyCreated: true, dedupeKey: "h2", priorHash: "h1", isGenuineChange: true }).action)
      .toBe("skip")
  })
})
