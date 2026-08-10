/**
 * Commission follows the money.
 *
 * The exposure being closed: commission is credited once at activation, and activation fires on the
 * FIRST payment. With a setup fee paid in parts that credited the referrer the full commission on
 * the whole fee while half the money had not arrived.
 *
 * The invariant that makes this safe to ship: the referrer's TOTAL never changes. Only the timing
 * does. Everything below exists to hold that line.
 */

import { describe, it, expect } from "vitest"
import {
  splitCommissionAcrossParts,
  commissionForPart,
  commissionDueAtSigning,
  trancheCommissionKey,
} from "@/lib/offers/tranche-commission"
import { validatePaymentPlan, type PaymentPlan } from "@/lib/offers/payment-plan"

/**
 * Build a REAL validated plan. It throws on refusal on purpose: the first version used `.plan!`
 * and handed `undefined` to the function under test, so a mistake in the fixture surfaced as a
 * crash inside production code and read like a production bug. A fixture that cannot build must
 * say so in its own name.
 */
function plan(...amounts: number[]): PaymentPlan {
  const res = validatePaymentPlan(
    amounts.map((amount, i) => ({
      seq: i + 1,
      amount,
      currency: "EUR",
      trigger: i === 0 ? { kind: "signing" } : { kind: "manual", label: `step ${i + 1}` },
    })),
  )
  if (!res.ok || !res.plan) {
    throw new Error(`test fixture is not a valid plan (${amounts.join("+")}): ${res.errors.join(" ")}`)
  }
  return res.plan
}

// Domenico's real agreement: EUR1,250 at signing, EUR1,250 when his bank account opens.
const DOMENICO = plan(1250, 1250)

describe("splitCommissionAcrossParts — the referrer's total never changes", () => {
  it("splits an even two-part fee down the middle", () => {
    const shares = splitCommissionAcrossParts(DOMENICO, 250)
    expect(shares.map((s) => s.commission)).toEqual([125, 125])
  })

  it("splits in proportion to each part's amount, not equally", () => {
    // A 2,000 + 500 plan is not a 50/50 commission split.
    const shares = splitCommissionAcrossParts(plan(2000, 500), 250)
    expect(shares.map((s) => s.commission)).toEqual([200, 50])
  })

  it("⛔ ALWAYS sums to the whole commission, exactly — the rounding case", () => {
    // Three parts of 2,500 at 10%: 83.33 + 83.33 + 83.34. Rounded independently these sum to
    // 249.99 and the referrer is a cent short for ever, silently. The last part absorbs it.
    const shares = splitCommissionAcrossParts(plan(833.34, 833.33, 833.33), 250)
    const sum = shares.reduce((s, x) => s + x.commission, 0)
    expect(Math.round(sum * 100) / 100).toBe(250)
  })

  it("sums exactly across a range of awkward splits", () => {
    const cases: Array<[number[], number]> = [
      [[1000, 333.33, 666.67], 137.5],
      [[100, 100, 100], 10],
      [[999.99, 0.01], 33.33],
      [[1, 1, 1, 1, 1, 1, 1], 1],
    ]
    for (const [amounts, total] of cases) {
      const sum = splitCommissionAcrossParts(plan(...amounts), total)
        .reduce((s, x) => s + x.commission, 0)
      expect(Math.round(sum * 100) / 100).toBe(total)
    }
  })

  it("never produces a negative share", () => {
    for (const shares of [
      splitCommissionAcrossParts(plan(1250, 1250), 250),
      splitCommissionAcrossParts(plan(0.01, 2499.99), 250),
    ]) {
      for (const s of shares) expect(s.commission).toBeGreaterThanOrEqual(0)
    }
  })

  it("a zero commission gives every part zero, without erroring", () => {
    // An ordinary referrer-less deal. Returning zeros rather than throwing keeps the caller
    // branch-free at the point where money is credited.
    const shares = splitCommissionAcrossParts(DOMENICO, 0)
    expect(shares.map((s) => s.commission)).toEqual([0, 0])
  })

  it("an empty plan returns nothing rather than throwing", () => {
    expect(splitCommissionAcrossParts([], 250)).toEqual([])
  })

  it("a single-part list still allocates the whole commission to it", () => {
    // Validation REFUSES a one-part plan ("that is just a single payment"), so this shape cannot
    // arrive from a stored offer. Covered anyway because the function is pure and callable, and
    // silently mis-allocating in an unreachable branch is how unreachable branches become reachable.
    const single: PaymentPlan = [
      { seq: 1, amount: 2500, currency: "EUR", trigger: { kind: "signing" } },
    ]
    expect(splitCommissionAcrossParts(single, 250)).toEqual([
      { seq: 1, partAmount: 2500, commission: 250 },
    ])
  })

  it("validation itself refuses a one-part plan, which is why the case above is unreachable", () => {
    const res = validatePaymentPlan([
      { seq: 1, amount: 2500, currency: "EUR", trigger: { kind: "signing" } },
    ])
    expect(res.ok).toBe(false)
    expect(res.errors.join(" ")).toContain("single payment")
  })

  it("reports each part's own agreed amount as the base it used", () => {
    // So a reader can see WHY a share is what it is, rather than trusting the number.
    expect(splitCommissionAcrossParts(DOMENICO, 250).map((s) => s.partAmount)).toEqual([1250, 1250])
  })

  it("orders shares by part regardless of how the plan was authored", () => {
    const scrambled = validatePaymentPlan([
      { seq: 2, amount: 500, currency: "EUR", trigger: { kind: "manual", label: "later" } },
      { seq: 1, amount: 2000, currency: "EUR", trigger: { kind: "signing" } },
    ]).plan!
    expect(splitCommissionAcrossParts(scrambled, 250).map((s) => s.seq)).toEqual([1, 2])
  })
})

describe("what is earned WHEN", () => {
  it("activation credits only the signing part's share, not the whole commission", () => {
    // This is the whole point: half the money has arrived, so half the commission is earned.
    expect(commissionDueAtSigning(DOMENICO, 250)).toBe(125)
  })

  it("credits NOTHING at signing when no part is due at signing", () => {
    // Correct rather than a gap: no money due at signing means no commission earned at signing.
    const allManual = validatePaymentPlan([
      { seq: 1, amount: 1250, currency: "EUR", trigger: { kind: "manual", label: "a" } },
      { seq: 2, amount: 1250, currency: "EUR", trigger: { kind: "manual", label: "b" } },
    ]).plan!
    expect(commissionDueAtSigning(allManual, 250)).toBe(0)
  })

  it("a later part carries its own share, earned when it is paid", () => {
    expect(commissionForPart(DOMENICO, 250, 2)).toBe(125)
  })

  it("a part that is not in the plan earns nothing", () => {
    expect(commissionForPart(DOMENICO, 250, 3)).toBe(0)
  })

  it("⛔ the commission base is the AGREED part, never cash received", () => {
    // A client holding a paid-call credit pays less cash, but the deal was sold at the same price
    // and the referrer introduced the same deal. Basing this on cash would dock the referrer for
    // someone else's credit. The function takes no credit argument at all — that is the guarantee.
    expect(splitCommissionAcrossParts.length).toBe(2)
    expect(commissionDueAtSigning(DOMENICO, 250)).toBe(125)
  })
})

describe("⛔ the idempotency key is per PART", () => {
  it("differs between parts, so paying part two credits rather than being swallowed", () => {
    // The existing whole-deal key would have made part two's credit look like a repeat of part
    // one's and silently dropped it.
    expect(trancheCommissionKey("mario-rossi-2026", 1)).not.toBe(
      trancheCommissionKey("mario-rossi-2026", 2),
    )
  })

  it("is stable for the same part, so a retry cannot double-credit", () => {
    expect(trancheCommissionKey("mario-rossi-2026", 2)).toBe(
      trancheCommissionKey("mario-rossi-2026", 2),
    )
  })

  it("is scoped to the offer, so two clients' parts never collide", () => {
    expect(trancheCommissionKey("mario-rossi-2026", 1)).not.toBe(
      trancheCommissionKey("giulia-verdi-2026", 1),
    )
  })

  it("does not collide with the existing whole-deal referral key shape", () => {
    // A tranche credit must never be mistaken for the pre-plan credit on the same offer.
    expect(trancheCommissionKey("mario-rossi-2026", 1)).not.toContain("referral:")
    expect(trancheCommissionKey("mario-rossi-2026", 1)).toContain("referral-tranche:")
  })
})
