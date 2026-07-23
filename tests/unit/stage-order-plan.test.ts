/**
 * Step numbers are semantic, and the planner is what protects them.
 *
 * `resolveSecondInstallmentAdvance` decides whether a second installment payment
 * may auto-advance a client by filtering `stage_order >= 1` — negative and zero
 * numbers mark intake stages a payment must never push a client past. So the
 * numbers are not presentation: renumbering a pipeline changes what a payment
 * does.
 *
 * These four assertions previously lived only in a database script that CI never
 * runs, on a pure function. They belong here, where the pre-push gate sees them.
 *
 * The bug they pin (found by council review of attempt four): the pool was built
 * from EVERY existing stage including the one being deleted, so deleting a stage
 * slid every survivor down one slot — a stage at 1 landing on -5 and silently
 * dropping out of the auto-advance set. The pool must come from the SURVIVORS.
 */

import { describe, it, expect } from "vitest"
import { planStageOrders, isLiveDeliveryStatus } from "@/lib/services/stages"

/** The real Tax Return shape: negative intake, gaps, wide spread. */
const REAL = [-10, 0, 10, 20, 35, 90]

describe("planStageOrders", () => {
  it("a no-op save gives every stage the number it already had", () => {
    expect(planStageOrders(REAL.length, REAL)).toEqual(REAL)
  })

  it("survivors keep their OWN numbers when a stage is deleted", () => {
    // Caller passes the SURVIVORS' orders, not everything that existed.
    const survivors = [0, 10, 20, 35, 90] // the -10 intake stage was removed
    expect(planStageOrders(survivors.length, survivors)).toEqual(survivors)
  })

  it("nothing crosses the intake boundary when a stage is deleted", () => {
    const survivors = [-10, -5, 10, 20] // the stage that sat at 1 was removed
    const planned = planStageOrders(survivors.length, survivors)
    expect(planned.filter(n => n >= 1)).toEqual([10, 20])
    expect(planned.filter(n => n < 1)).toEqual([-10, -5])
  })

  it("a reorder permutes the existing numbers and invents none", () => {
    const planned = planStageOrders(REAL.length, REAL)
    expect([...planned].sort((a, b) => a - b)).toEqual([...REAL].sort((a, b) => a - b))
  })

  it("added stages extend past the maximum instead of compressing the scale", () => {
    expect(planStageOrders(REAL.length + 2, REAL)).toEqual([...REAL, 100, 110])
  })

  it("an empty pipeline starts at 10", () => {
    expect(planStageOrders(3, [])).toEqual([10, 20, 30])
  })

  it("never emits a duplicate, which would violate the unique index", () => {
    for (const count of [0, 1, 5, 12, 40]) {
      const planned = planStageOrders(count, REAL)
      expect(new Set(planned).size).toBe(planned.length)
    }
  })

  it("never emits a value in the park band", () => {
    const planned = planStageOrders(30, REAL)
    expect(planned.every(n => n < 100000)).toBe(true)
  })
})

describe("isLiveDeliveryStatus", () => {
  it("blocked is live work — 135 such deliveries exist", () => {
    expect(isLiveDeliveryStatus("blocked")).toBe(true)
  })

  it("matches regardless of case or padding — two rows say 'Active'", () => {
    expect(isLiveDeliveryStatus("Active")).toBe(true)
    expect(isLiveDeliveryStatus(" COMPLETED ")).toBe(false)
  })

  it("finished work does not block a delete", () => {
    expect(isLiveDeliveryStatus("completed")).toBe(false)
    expect(isLiveDeliveryStatus("cancelled")).toBe(false)
    expect(isLiveDeliveryStatus("inactive")).toBe(false)
  })

  it("an unknown status counts as live — fail safe, never destroy", () => {
    expect(isLiveDeliveryStatus("something_new")).toBe(true)
    expect(isLiveDeliveryStatus(null)).toBe(true)
    expect(isLiveDeliveryStatus(undefined)).toBe(true)
  })
})
