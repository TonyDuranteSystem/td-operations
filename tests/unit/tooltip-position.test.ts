/**
 * Where a hover label/card is placed. The summary card on an invoice number is several lines tall,
 * so it must flip ABOVE the number sooner than a one-line label does — otherwise a number near the
 * bottom of the screen shows a card cut off by the window edge.
 */
import { describe, it, expect } from "vitest"
import { tooltipPosition } from "@/lib/ui/tooltip-position"

const rect = { left: 100, right: 180, top: 700, bottom: 720, width: 80 }

describe("tooltipPosition", () => {
  it("puts a one-line label below the anchor when it fits, aligned as asked", () => {
    expect(tooltipPosition(rect, "left", 800)).toEqual({ top: 724, left: 100, translateX: "0", translateY: "0" })
    expect(tooltipPosition(rect, "right", 800)).toMatchObject({ left: 180, translateX: "-100%" })
    expect(tooltipPosition(rect, "center", 800)).toMatchObject({ left: 140, translateX: "-50%" })
  })

  it("flips a one-line label above only when less than one line of room is left", () => {
    expect(tooltipPosition(rect, "left", 752).translateY).toBe("0")
    expect(tooltipPosition(rect, "left", 751).translateY).toBe("-100%")
  })

  it("flips a tall card above much sooner, because it needs several lines of room", () => {
    // 80px of room below the number: a one-line label fits, a 150px card does not.
    expect(tooltipPosition(rect, "left", 800).translateY).toBe("0")
    expect(tooltipPosition(rect, "left", 800, 150)).toEqual({ top: 696, left: 100, translateX: "0", translateY: "-100%" })
    expect(tooltipPosition(rect, "left", 900, 150).translateY).toBe("0")
  })

  it("does not flip when the window height is unknown", () => {
    expect(tooltipPosition(rect, "left").translateY).toBe("0")
  })
})
