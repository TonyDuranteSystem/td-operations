/**
 * The words of the "already-paid invoices of exactly this amount" box. The box must never call a coincidence of
 * amount and date a match: one invoice is "the only one", several say how many, and the caution is always there.
 */
import { describe, it, expect } from "vitest"
import {
  dayOffsetText,
  dropAlreadyShown,
  MAX_SHOWN_NEAR,
  MAX_SHOWN_WIDE,
  normalizeDays,
  SAME_AMOUNT_CAUTION,
  SAME_AMOUNT_DAYS,
  SAME_AMOUNT_WIDER_DAYS,
  sameAmountEmptyText,
  sameAmountHeadline,
  sameAmountTiedText,
  shownCap,
} from "@/lib/finance/same-amount-labels"

describe("normalizeDays / shownCap", () => {
  it("is 3 days unless exactly 30 is asked for", () => {
    expect(normalizeDays(null)).toBe(SAME_AMOUNT_DAYS)
    expect(normalizeDays(undefined)).toBe(SAME_AMOUNT_DAYS)
    expect(normalizeDays("abc")).toBe(SAME_AMOUNT_DAYS)
    expect(normalizeDays("3")).toBe(SAME_AMOUNT_DAYS)
    expect(normalizeDays("365")).toBe(SAME_AMOUNT_DAYS)
    expect(normalizeDays(30)).toBe(SAME_AMOUNT_WIDER_DAYS)
    expect(normalizeDays("30")).toBe(SAME_AMOUNT_WIDER_DAYS)
  })
  it("lists a few for the everyday window and more for the wider one", () => {
    expect(shownCap(SAME_AMOUNT_DAYS)).toBe(MAX_SHOWN_NEAR)
    expect(shownCap(SAME_AMOUNT_WIDER_DAYS)).toBe(MAX_SHOWN_WIDE)
    expect(MAX_SHOWN_NEAR).toBeLessThan(MAX_SHOWN_WIDE)
  })
})

describe("dayOffsetText", () => {
  it("says same day, and how many days before or after", () => {
    expect(dayOffsetText(0)).toBe("same day")
    expect(dayOffsetText(1)).toBe("1 day after")
    expect(dayOffsetText(-1)).toBe("1 day before")
    expect(dayOffsetText(-3)).toBe("3 days before")
    expect(dayOffsetText(12)).toBe("12 days after")
  })
  it("says nothing when the day is unknown", () => {
    expect(dayOffsetText(null)).toBe("")
    expect(dayOffsetText(undefined)).toBe("")
    expect(dayOffsetText(Number.NaN)).toBe("")
  })
})

describe("the heading never calls a coincidence a match", () => {
  it("one invoice is 'the only' one, with the window", () => {
    expect(sameAmountHeadline(1, 3, "€3,000.00")).toBe("The only paid invoice of exactly €3,000.00 within 3 days of this payment")
  })
  it("several say how many", () => {
    expect(sameAmountHeadline(5, 3, "$1,000.00")).toBe("5 paid invoices of exactly $1,000.00 within 3 days of this payment")
    expect(sameAmountHeadline(24, 30, "$1,000.00")).toBe("24 paid invoices of exactly $1,000.00 within 30 days of this payment")
  })
  it("the caution says only the amount and date match", () => {
    expect(SAME_AMOUNT_CAUTION).toContain("Only the amount and the date match")
    expect(SAME_AMOUNT_CAUTION).toContain("check before linking")
    expect(sameAmountHeadline(1, 3, "€1")).not.toMatch(/match(es|ed)?\b/i)
  })
})

describe("the empty and left-out lines", () => {
  it("names the window and the amount when nothing fits", () => {
    expect(sameAmountEmptyText(3, "€3,800.00")).toBe("No paid invoice of exactly €3,800.00 within 3 days of this payment.")
    expect(sameAmountEmptyText(30, "€3,800.00")).toContain("within 30 days")
  })
  it("counts what was left out because another bank payment has it", () => {
    expect(sameAmountTiedText(0)).toBe("")
    expect(sameAmountTiedText(1)).toBe("1 more was left out because another bank payment is already tied to it.")
    expect(sameAmountTiedText(3)).toBe("3 more were left out because another bank payment is already tied to them.")
  })
})

describe("dropAlreadyShown", () => {
  const rows = [
    { id: "a", invoice_number: "INV-1" },
    { id: "b", invoice_number: "INV-2" },
    { id: "c", invoice_number: null },
  ]
  it("drops what the popup already lists, by id", () => {
    expect(dropAlreadyShown(rows, new Set(["a"])).map((r) => r.id)).toEqual(["b", "c"])
  })
  it("drops the proposed-invoice banner's invoice by number", () => {
    expect(dropAlreadyShown(rows, new Set(), "INV-2").map((r) => r.id)).toEqual(["a", "c"])
  })
  it("keeps everything when nothing is shown elsewhere, and never drops an invoice with no number by a missing number", () => {
    expect(dropAlreadyShown(rows, new Set())).toHaveLength(3)
    expect(dropAlreadyShown(rows, new Set(), null)).toHaveLength(3)
    expect(dropAlreadyShown(rows, new Set(), "")).toHaveLength(3)
  })
})
