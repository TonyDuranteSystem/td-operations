import { describe, it, expect } from "vitest"
import { PLAN_TOTAL_TOLERANCE, planTotalMatchesGross } from "@/lib/offers/payment-plan"

/**
 * These tests exist because the authoring screen once carried its OWN, looser tolerance (0.5)
 * while the engine used 0.01, and nothing crosschecked plan-vs-gross on the server. A plan two
 * cents short passed the only gate and was then refused by every consumer downstream. The
 * constant is now shared; this pins it so a future edit cannot loosen it silently.
 */
describe("plan total tolerance", () => {
  it("is one cent — the authoring screen and the engine must never disagree again", () => {
    expect(PLAN_TOTAL_TOLERANCE).toBe(0.01)
  })

  it("accepts an exact match", () => {
    expect(planTotalMatchesGross(3500, 3500)).toBe(true)
  })

  it("accepts float drift from splitting a fee into thirds", () => {
    // 2500 / 3 typed to the cent — the realistic legitimate case. A FALSE rejection here
    // would block a real sale, so it is as much a defect as a false acceptance.
    expect(planTotalMatchesGross(833.33 + 833.33 + 833.34, 2500)).toBe(true)
    expect(planTotalMatchesGross(1166.67 + 1166.67 + 1166.66, 3500)).toBe(true)
    expect(planTotalMatchesGross(0.1 + 0.2, 0.3)).toBe(true)
  })

  it("REFUSES a one-cent authoring error — the tolerance absorbs float drift, not real mistakes", () => {
    // 3500.01 - 3500 evaluates to 0.010000000000218 in IEEE-754, so a hand-typed one-cent
    // difference lands just outside. That is the behaviour the engine has always had, and it
    // is the one we want: a plan that really is a cent off is a mistake, not rounding.
    // Asserted rather than assumed — the first version of this test claimed the opposite and
    // failed, which is how the true boundary got pinned.
    expect(planTotalMatchesGross(3500.01, 3500)).toBe(false)
    expect(planTotalMatchesGross(1750 + 1749.99, 3500)).toBe(false)
  })

  // ─── THE REGRESSION ───
  it("REFUSES the two-cent case that the old 0.5 tolerance let through", () => {
    // 3500 split three ways as 1166.66 each = 3499.98. Under the old gate this reached the
    // client: offer page hid the payment block, contract could not state the amount, and
    // signing billed the whole 3500.
    expect(planTotalMatchesGross(1166.66 * 3, 3500)).toBe(false)
  })

  it("refuses anything the old gate would have waved through below half a euro", () => {
    for (const diff of [0.02, 0.1, 0.25, 0.49]) {
      expect(planTotalMatchesGross(3500 - diff, 3500)).toBe(false)
    }
  })

  it("refuses a plainly wrong total in either direction", () => {
    expect(planTotalMatchesGross(2500, 3500)).toBe(false)
    expect(planTotalMatchesGross(3500, 2500)).toBe(false)
  })
})
