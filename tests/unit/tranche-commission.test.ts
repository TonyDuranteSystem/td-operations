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
  decideAccrual,
  ISSUER_SUPPORTS_PER_PART_KEY,
} from "@/lib/offers/tranche-commission"
import { validatePaymentPlan, type PaymentPlan } from "@/lib/offers/payment-plan"
import { DEAD_INVOICE_STATUSES, computePlanStatus } from "@/lib/offers/payment-plan-state"
import { buildCommissionReviewMessage } from "@/lib/offers/tranche-commission-issue"

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

  it("⛔ never EXCEEDS the whole commission either — the tiny-last-part edge", () => {
    // Council, 2026-08-11: rounded-up earlier shares can drive the raw last share negative, and
    // the zero-clamp then made the SUM exceed the total (0.34+0.34+0 = 0.68 on 0.671). The
    // overshoot now comes off the largest share.
    const shares = splitCommissionAcrossParts(plan(100, 100, 0.01), 0.671)
    const sum = Math.round(shares.reduce((a, x) => a + x.commission, 0) * 100) / 100
    expect(sum).toBeLessThanOrEqual(0.671)
    for (const x of shares) expect(x.commission).toBeGreaterThanOrEqual(0)
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

// ══════════════════════════════════════════════════════════════════════════════════════════
//  WHEN a share accrues — the dead-part question, proved with the SAME three dead states
//  used on the database index, because the two must agree about what "over" means.
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("⛔ accrual is on PAYMENT, never on raising", () => {
  it("does not accrue for a part that has only been raised", () => {
    const d = decideAccrual("credit_note", "raised_unsent")
    expect(d.accrue).toBe(false)
    expect(d.refusal).toBe("not_paid_yet")
  })

  it("does not accrue for a part that is sent and awaiting payment", () => {
    expect(decideAccrual("credit_note", "awaiting_payment").accrue).toBe(false)
  })

  it("does not accrue for a PART-paid part", () => {
    // Some money arrived, not all of it. Crediting a full share here would pay a partner for
    // money the client still owes.
    expect(decideAccrual("credit_note", "part_paid").accrue).toBe(false)
  })

  it("the share is EARNED once the part is paid (entitlement, proved with the prerequisite met)", () => {
    expect(decideAccrual("percentage", "paid", { issuerSupportsPerPartKey: true }).accrue).toBe(true)
  })

  it.each(DEAD_INVOICE_STATUSES)(
    "a %s invoice leaves its part unaccrued — nothing was earned, so nothing needs reversing",
    (status) => {
      // The point: a dead invoice makes the part read as never-raised, which is exactly the state
      // that cannot accrue. Raise, void, raise again, pay once = exactly one share, because only
      // the payment counted. No special case for dead parts is needed anywhere.
      const plan2 = plan(1250, 1250)
      const st = computePlanStatus(plan2, [
        {
          id: "dead-1",
          invoice_number: "INV-000502",
          invoice_status: status,
          amount_paid: 0,
          amount: 1250,
          tranche_seq: 2,
          due_date: null,
        },
      ])
      expect(st.parts[1].state).toBe("not_raised")
      expect(decideAccrual("credit_note", st.parts[1].state).accrue).toBe(false)
    },
  )

  it("a re-raised part accrues exactly once — on the payment, not on either raise", () => {
    const plan2 = plan(1250, 1250)
    const st = computePlanStatus(plan2, [
      { id: "dead", invoice_number: "INV-1", invoice_status: "Voided", amount_paid: 0, amount: 1250, tranche_seq: 2, due_date: null },
      { id: "live", invoice_number: "INV-2", invoice_status: "Paid", amount_paid: 1250, amount: 1250, tranche_seq: 2, due_date: null },
    ])
    expect(st.parts[1].state).toBe("paid")
    expect(decideAccrual("credit_note", st.parts[1].state, { issuerSupportsPerPartKey: true }).accrue).toBe(true)
    // And the key for that part is stable, so the credit cannot be issued twice for it.
    expect(trancheCommissionKey("t", 2)).toBe(trancheCommissionKey("t", 2))
  })
})

describe("⛔ a price-difference arrangement is REFUSED, not sliced", () => {
  it("refuses even when the part is paid", () => {
    // Excluded and loud beats included and wrong. Its commission is the partner's margin over
    // TD's base cost, and TD pays that cost up front rather than in step with the client's parts.
    const d = decideAccrual("price_difference", "paid")
    expect(d.accrue).toBe(false)
    expect(d.refusal).toBe("not_divisible_by_part")
  })

  it("explains WHY in words a person can act on", () => {
    const d = decideAccrual("price_difference", "paid")
    expect(d.reason).toContain("base cost")
    expect(d.reason).toContain("by hand")
  })

  it("does NOT fall through the percentage path and invent a number", () => {
    // The failure this prevents: a partner silently credited a pro-rata slice of a margin that
    // was never agreed per part.
    expect(decideAccrual("price_difference", "paid").accrue).toBe(false)
  })

  it("the two share-of-fee arrangements DO earn per part", () => {
    for (const t of ["percentage", "credit_note"]) {
      expect(decideAccrual(t, "paid", { issuerSupportsPerPartKey: true }).accrue).toBe(true)
    }
  })

  it("an unknown commission type is treated as a share of the fee, like the existing calculator", () => {
    // Deliberate consistency with the calculator's own default rather than a new refusal: a new
    // type should be decided where commission is CALCULATED, not silently blocked here.
    expect(decideAccrual("something_new", "paid", { issuerSupportsPerPartKey: true }).accrue).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
//  THE STRUCTURAL INTERLOCK — the previous version of this protection was a comment, and a
//  comment does not stop anybody.
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("⛔ nothing can accrue while the credit path cannot key per part", () => {
  it("the interlock is OFF today", () => {
    expect(ISSUER_SUPPORTS_PER_PART_KEY).toBe(false)
  })

  it("refuses an earned share by DEFAULT — no caller can accidentally issue one", () => {
    // Note the shape: entitlement and ability are separate. The share IS earned; we simply cannot
    // pay it correctly yet, so the refusal names that rather than pretending nothing is owed.
    const d = decideAccrual("percentage", "paid")
    expect(d.accrue).toBe(false)
    expect(d.refusal).toBe("issuer_cannot_key_per_part")
    expect(d.reason).toContain("by hand")
    expect(d.reason).toContain("under-paid")
  })

  it("refuses for every share-of-fee type, not just one", () => {
    for (const t of ["percentage", "credit_note", "something_new"]) {
      expect(decideAccrual(t, "paid").accrue).toBe(false)
    }
  })

  it("the price-difference refusal still wins over the interlock", () => {
    // Order matters for the message a human reads: a price-difference deal needs a different
    // decision from Antonio, not "wait for a prerequisite".
    expect(decideAccrual("price_difference", "paid").refusal).toBe("not_divisible_by_part")
  })

  it("not-paid still reports not-paid rather than the interlock", () => {
    // Otherwise every unpaid part would blame the prerequisite and hide the real reason.
    expect(decideAccrual("percentage", "awaiting_payment").refusal).toBe("not_paid_yet")
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
//  THE INTERIM GUARD's card — Antonio's decision: suppress the automatic credit, surface the
//  deal with everything needed to settle it. A card that only says "do this by hand" sends the
//  reader back to the database to work out what and how much.
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("the hand-settlement card carries the amount and the parts", () => {
  // The REAL production shape: the reward is USD by the standing rule (netted against USD
  // installments, no FX) while the deal itself is a EUR setup fee. The gate's commission cell
  // (2026-08-11) caught the card labelling the DEAL figures with the reward's currency — the
  // architect's ruling: a money card that misstates a currency is a trap for whoever reads it
  // months later, so the two currencies are pinned separately here.
  const msg = buildCommissionReviewMessage({
    clientName: "Mario Rossi",
    referrerName: "Studio Bianchi",
    commissionType: "credit_note",
    totalCommission: 250,
    currency: "USD",
    dealCurrency: "EUR",
    plan: plan(1250, 1250),
  })

  it("names the client and the referrer", () => {
    expect(msg).toContain("Mario Rossi")
    expect(msg).toContain("Studio Bianchi")
  })

  it("states the total AND every part's share", () => {
    expect(msg).toContain("250 USD")
    expect(msg).toContain("part 1 of 2")
    expect(msg).toContain("part 2 of 2")
    expect(msg.match(/125 USD/g)?.length).toBe(2)
  })

  it("labels the deal figures with the DEAL's currency, never the reward's", () => {
    expect(msg.match(/deal 1250 EUR/g)?.length).toBe(2)
    expect(msg).not.toContain("deal 1250 USD")
  })

  it("says plainly that nothing was credited", () => {
    // The dangerous misreading is that the card is a receipt rather than a to-do.
    expect(msg).toContain("Nothing was credited automatically")
    expect(msg).toContain("nothing has issued")
  })

  it("explains WHY, so the reader does not 'fix' it by wiring the accrual", () => {
    expect(msg).toContain("silently swallowed")
    expect(msg).toContain("under-paid")
  })

  it("never uses the banned renewal vocabulary, even on an internal card", () => {
    // Staff-facing, but the wording rule is about not confusing the two arrangements ANYWHERE —
    // and this text is the thing a human copies into an email.
    expect(msg.toLowerCase()).not.toMatch(/\b(rat[ae]|instal?lments?)\b/)
  })
})
