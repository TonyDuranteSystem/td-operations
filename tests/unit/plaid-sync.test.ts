import { describe, it, expect } from "vitest"
import { shouldSkipBeforeCutover, plaidAmountToSignedAmount } from "@/lib/plaid-sync"

describe("shouldSkipBeforeCutover", () => {
  it("no cutover set — nothing is skipped, even a very old date", () => {
    expect(shouldSkipBeforeCutover("2020-01-01", null)).toBe(false)
  })

  it("a transaction dated exactly on the cutover is skipped (boundary is inclusive)", () => {
    // The cutover date is Antonio's own last hand-entered day — that day's activity is already
    // in the books by hand, so the boundary itself must be excluded, not just strictly-before.
    expect(shouldSkipBeforeCutover("2026-09-10", "2026-09-10")).toBe(true)
  })

  it("a transaction dated before the cutover is skipped", () => {
    expect(shouldSkipBeforeCutover("2026-09-01", "2026-09-10")).toBe(true)
  })

  it("a transaction dated after the cutover is kept", () => {
    expect(shouldSkipBeforeCutover("2026-09-11", "2026-09-10")).toBe(false)
  })

  it("compares as plain strings — no timezone drift across a year boundary", () => {
    expect(shouldSkipBeforeCutover("2025-12-31", "2026-01-01")).toBe(true)
    expect(shouldSkipBeforeCutover("2026-01-02", "2026-01-01")).toBe(false)
  })
})

describe("plaidAmountToSignedAmount", () => {
  // Plaid's own convention, for every account type including credit cards: positive = money
  // out, negative = money in. This must be the ONLY conversion applied — a registry
  // sign_convention flip must never be layered on top (that was the real, previously-repaired
  // Amex bug: $80,457 of spending posted as income). These cases stand in for that exact
  // scenario and must never regress.

  it("a Plaid charge/purchase (positive raw amount) becomes a negative — an expense", () => {
    // e.g. a $500 Amex purchase: Plaid reports +500.
    expect(plaidAmountToSignedAmount(500)).toBe(-500)
  })

  it("a Plaid deposit/payment (negative raw amount) becomes a positive — income", () => {
    // e.g. a $500 payment toward the same Amex card: Plaid reports -500.
    expect(plaidAmountToSignedAmount(-500)).toBe(500)
  })

  it("a checking-account deposit (negative raw amount) becomes a positive — unaffected by account type", () => {
    expect(plaidAmountToSignedAmount(-2409.52)).toBe(2409.52)
  })

  it("a checking-account withdrawal (positive raw amount) becomes a negative — unaffected by account type", () => {
    expect(plaidAmountToSignedAmount(150)).toBe(-150)
  })

  it("zero stays zero", () => {
    expect(plaidAmountToSignedAmount(0)).toBe(-0)
  })
})
