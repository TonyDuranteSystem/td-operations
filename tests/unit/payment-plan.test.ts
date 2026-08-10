/**
 * Offer payment plans — the shape of a setup fee paid in parts. WS-C item 2, dev job `c0a61e44`.
 *
 * The three constraints from the approved design are asserted here, because this module is the
 * only thing between a typo in a jsonb column and a client being billed the wrong figure:
 * N parts (not two slots), triggers as data with no scheduler, and ONE currency refused at save.
 *
 * Domenico's real plan is the primary fixture: EUR1,250 on signing, EUR1,250 when his bank account
 * opens. His deal was executed by hand before this model existed, so the model has a reference
 * implementation to reconcile against rather than a specification to interpret.
 */
import { describe, it, expect } from "vitest"
import {
  TRANCHE_EVENTS,
  clientFacingPartLabel,
  clientFacingSchedule,
  decideSigningBill,
  laterParts,
  planCurrency,
  planTotal,
  signingPart,
  trancheInvoiceDescription,
  validatePaymentPlan,
  type PaymentPlan,
} from "@/lib/offers/payment-plan"

/** Domenico's agreement, as the model should hold it. */
const DOMENICO_PLAN = [
  { seq: 1, amount: 1250, currency: "EUR", trigger: { kind: "signing" }, internal_label: "on signing" },
  {
    seq: 2,
    amount: 1250,
    currency: "EUR",
    trigger: { kind: "event", event: "bank_account_opened" },
    internal_label: "when Relay opens",
  },
]

describe("validatePaymentPlan — accepts a real plan", () => {
  it("accepts Domenico's two-part plan and normalises it", () => {
    const res = validatePaymentPlan(DOMENICO_PLAN)
    expect(res.ok).toBe(true)
    expect(res.errors).toEqual([])
    expect(res.plan).toHaveLength(2)
    expect(planTotal(res.plan!)).toBe(2500)
    expect(planCurrency(res.plan!)).toBe("EUR")
  })

  it("treats no plan as a single payment rather than an error", () => {
    expect(validatePaymentPlan(null).ok).toBe(true)
    expect(validatePaymentPlan(null).plan).toBeUndefined()
  })

  it("uppercases the currency so 'eur' and 'EUR' are not two currencies", () => {
    const res = validatePaymentPlan([
      { seq: 1, amount: 100, currency: "eur", trigger: { kind: "signing" } },
      { seq: 2, amount: 100, currency: "EUR", trigger: { kind: "manual" } },
    ])
    expect(res.ok).toBe(true)
    expect(planCurrency(res.plan!)).toBe("EUR")
  })
})

describe("CONSTRAINT 1 — N parts, not two slots", () => {
  it("accepts a three-part plan with no code change", () => {
    const res = validatePaymentPlan([
      { seq: 1, amount: 1000, currency: "USD", trigger: { kind: "signing" } },
      { seq: 2, amount: 1000, currency: "USD", trigger: { kind: "event", event: "ein_received" } },
      { seq: 3, amount: 500, currency: "USD", trigger: { kind: "manual" } },
    ])
    expect(res.ok).toBe(true)
    expect(res.plan).toHaveLength(3)
    expect(planTotal(res.plan!)).toBe(2500)
  })

  it("refuses gaps or repeats in the part numbers", () => {
    const gap = validatePaymentPlan([
      { seq: 1, amount: 100, currency: "USD", trigger: { kind: "signing" } },
      { seq: 3, amount: 100, currency: "USD", trigger: { kind: "manual" } },
    ])
    expect(gap.ok).toBe(false)
    expect(gap.errors.join(" ")).toContain("numbered 1 to 2")
  })
})

describe("CONSTRAINT 2 — triggers are data, and there is no scheduler", () => {
  it("stores each of the four trigger kinds", () => {
    for (const kind of ["signing", "event", "date", "manual"] as const) {
      const part =
        kind === "event"
          ? { seq: 1, amount: 100, currency: "USD", trigger: { kind, event: "bank_account_opened" } }
          : kind === "date"
            ? { seq: 1, amount: 100, currency: "USD", trigger: { kind, date: "2026-09-01" } }
            : { seq: 1, amount: 100, currency: "USD", trigger: { kind } }
      const res = validatePaymentPlan([part, { seq: 2, amount: 100, currency: "USD", trigger: { kind: "manual" } }])
      expect(res.ok).toBe(true)
      expect(res.plan![0].trigger.kind).toBe(kind)
    }
  })

  it("refuses an unknown event rather than waiting for something that never fires", () => {
    const res = validatePaymentPlan([
      { seq: 1, amount: 100, currency: "USD", trigger: { kind: "signing" } },
      { seq: 2, amount: 100, currency: "USD", trigger: { kind: "event", event: "relay_opens_maybe" } },
    ])
    expect(res.ok).toBe(false)
    expect(res.errors.join(" ")).toContain("not a known trigger event")
    // The vocabulary is finite, so a typo is a validation error and not a silent forever-wait.
    expect(TRANCHE_EVENTS).toContain("bank_account_opened")
  })

  it("refuses a date trigger with no date", () => {
    const res = validatePaymentPlan([
      { seq: 1, amount: 100, currency: "USD", trigger: { kind: "signing" } },
      { seq: 2, amount: 100, currency: "USD", trigger: { kind: "date" } },
    ])
    expect(res.ok).toBe(false)
    expect(res.errors.join(" ")).toContain("needs a date")
  })

  it("'manual' is always available and needs nothing else", () => {
    const res = validatePaymentPlan([
      { seq: 1, amount: 100, currency: "USD", trigger: { kind: "manual" } },
      { seq: 2, amount: 100, currency: "USD", trigger: { kind: "manual" } },
    ])
    expect(res.ok).toBe(true)
  })
})

describe("CONSTRAINT 3 — one currency, refused at save", () => {
  it("⛔ REFUSES a mixed-currency plan, and explains why", () => {
    const res = validatePaymentPlan([
      { seq: 1, amount: 1250, currency: "EUR", trigger: { kind: "signing" } },
      { seq: 2, amount: 1250, currency: "USD", trigger: { kind: "manual" } },
    ])
    expect(res.ok).toBe(false)
    const why = res.errors.join(" ")
    expect(why).toContain("ONE currency")
    expect(why).toContain("EUR and USD")
    // The reason matters: refusing here is the only place the error can be explained, because
    // credit, bank matching and activation each fail separately and much further down.
    expect(why).toContain("single-currency")
  })

  it("does not coerce or pick a winner — it refuses", () => {
    const res = validatePaymentPlan([
      { seq: 1, amount: 1250, currency: "EUR", trigger: { kind: "signing" } },
      { seq: 2, amount: 1250, currency: "USD", trigger: { kind: "manual" } },
    ])
    expect(res.plan).toBeUndefined()
  })
})

describe("the activation anchor", () => {
  it("finds the signing part", () => {
    const plan = validatePaymentPlan(DOMENICO_PLAN).plan!
    expect(signingPart(plan)?.seq).toBe(1)
    expect(signingPart(plan)?.amount).toBe(1250)
  })

  it("refuses two signing parts — two anchors makes 'is this deal live?' ambiguous", () => {
    const res = validatePaymentPlan([
      { seq: 1, amount: 100, currency: "USD", trigger: { kind: "signing" } },
      { seq: 2, amount: 100, currency: "USD", trigger: { kind: "signing" } },
    ])
    expect(res.ok).toBe(false)
    expect(res.errors.join(" ")).toContain("Only one part can be due on signing")
  })

  it("separates the parts a human mints later", () => {
    const plan = validatePaymentPlan(DOMENICO_PLAN).plan!
    expect(laterParts(plan).map((p) => p.seq)).toEqual([2])
  })
})

describe("⛔ CLIENT-FACING WORDING — never 'instalment'", () => {
  const plan = validatePaymentPlan(DOMENICO_PLAN).plan!

  it("says what is due and when, in the client's terms", () => {
    expect(clientFacingPartLabel(plan[0], 2)).toBe("Part 1 of 2, due on signing")
    expect(clientFacingPartLabel(plan[1], 2)).toBe("Part 2 of 2, due when your bank account is open")
  })

  it("NEVER uses the renewal contract's vocabulary, in any label or description", () => {
    // Antonio's rule, non-negotiable: "instalment" belongs to the renewal contract. A formation
    // client must not see it — the separation from the annual Jan/Jun machinery holds in the words
    // as well as in the data.
    const strings = [
      ...plan.map((p) => clientFacingPartLabel(p, plan.length)),
      ...plan.map((p) => trancheInvoiceDescription(p, plan.length, "LLC Formation")),
    ]
    for (const s of strings) {
      expect(s.toLowerCase()).not.toContain("instalment")
      expect(s.toLowerCase()).not.toContain("installment")
    }
  })

  it("uses Antonio's own invoice wording — 'Partial Payment'", () => {
    expect(trancheInvoiceDescription(plan[1], 2, "LLC Formation")).toBe(
      "LLC Formation — Partial Payment (part 2 of 2)",
    )
  })

  it("falls back to neutral wording for an event it has no phrasing for", () => {
    const odd = { seq: 2, amount: 1, currency: "USD", trigger: { kind: "event" as const, event: "company_formed" } }
    expect(clientFacingPartLabel(odd, 2)).toContain("when your company is formed")
  })
})

describe("the arithmetic that reaches a contract", () => {
  it("rounds the total to cents (no floating-point dust in a client's figure)", () => {
    const plan: PaymentPlan = [
      { seq: 1, amount: 0.1, currency: "USD", trigger: { kind: "signing" } },
      { seq: 2, amount: 0.2, currency: "USD", trigger: { kind: "manual" } },
    ]
    expect(planTotal(plan)).toBe(0.3)
  })

  it("refuses a zero or negative part", () => {
    const res = validatePaymentPlan([
      { seq: 1, amount: 0, currency: "USD", trigger: { kind: "signing" } },
      { seq: 2, amount: -50, currency: "USD", trigger: { kind: "manual" } },
    ])
    expect(res.ok).toBe(false)
    expect(res.errors.filter((e) => e.includes("greater than zero"))).toHaveLength(2)
  })

  it("calls a one-part plan out as pointless rather than accepting it silently", () => {
    const res = validatePaymentPlan([{ seq: 1, amount: 100, currency: "USD", trigger: { kind: "signing" } }])
    expect(res.ok).toBe(false)
    expect(res.errors.join(" ")).toContain("just a single payment")
  })

  it("refuses something that is not a list at all", () => {
    expect(validatePaymentPlan("two payments").ok).toBe(false)
    expect(validatePaymentPlan({ seq: 1 }).ok).toBe(false)
    expect(validatePaymentPlan([]).ok).toBe(false)
  })
})

describe("reconciliation against Domenico's hand-executed deal", () => {
  it("the model's view of his plan matches what was actually done", () => {
    // Executed by hand on production 2026-08-09: invoice brought to EUR1,250, settled in full,
    // activation fired from that payment, EUR1,250 still owed on the Relay trigger.
    const plan = validatePaymentPlan(DOMENICO_PLAN).plan!
    expect(planTotal(plan)).toBe(2500) // his signed commitment, unchanged
    expect(signingPart(plan)!.amount).toBe(1250) // the invoice he actually paid
    expect(laterParts(plan)).toHaveLength(1)
    expect(laterParts(plan)[0].amount).toBe(1250) // what is still outstanding
    expect(laterParts(plan)[0].trigger.event).toBe("bank_account_opened") // when it falls due
  })
})

describe("⛔ the Italian register carries the same ban", () => {
  const plan = validatePaymentPlan(DOMENICO_PLAN).plan!

  it("says what is due and when, in Italian", () => {
    expect(clientFacingPartLabel(plan[0], 2, "it")).toBe("Parte 1 di 2, alla firma")
    expect(clientFacingPartLabel(plan[1], 2, "it")).toBe("Parte 2 di 2, all'apertura del conto bancario")
  })

  it("NEVER uses the renewal contract's Italian vocabulary either", () => {
    // "rata" / "rateizzazione" is what the ANNUAL contract calls its Jan/Jun payments. A
    // formation client must not see it, for the same reason the English side must not see
    // "instalment": it imports the wrong contract and the wrong machinery.
    for (const lang of ["en", "it"] as const) {
      for (const p of plan) {
        const s = clientFacingPartLabel(p, plan.length, lang).toLowerCase()
        expect(s).not.toContain("rata")
        expect(s).not.toContain("rate")
        expect(s).not.toContain("instalment")
        expect(s).not.toContain("installment")
      }
    }
  })

  it("defaults to English when no language is given, so a missing argument cannot leak Italian", () => {
    expect(clientFacingPartLabel(plan[0], 2)).toBe(clientFacingPartLabel(plan[0], 2, "en"))
  })
})

describe("clientFacingSchedule — one sentence per part, in order", () => {
  it("describes the whole agreement without formatting the money", () => {
    const plan = validatePaymentPlan(DOMENICO_PLAN).plan!
    const rows = clientFacingSchedule(plan)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ seq: 1, amount: 1250, currency: "EUR", label: "Part 1 of 2, due on signing" })
    expect(rows[1].label).toBe("Part 2 of 2, due when your bank account is open")
    // Money stays a number: each surface owns its own symbol and locale rules, and a
    // pre-formatted string here would be a fourth place for them to disagree.
    expect(typeof rows[1].amount).toBe("number")
  })

  it("keeps part order regardless of how the plan was authored", () => {
    const plan = validatePaymentPlan([
      { seq: 2, amount: 100, currency: "USD", trigger: { kind: "manual" } },
      { seq: 1, amount: 100, currency: "USD", trigger: { kind: "signing" } },
    ]).plan!
    expect(clientFacingSchedule(plan).map((r) => r.seq)).toEqual([1, 2])
  })
})

describe("decideSigningBill — what signing actually asks the client for", () => {
  const base = { offerToken: "domenico-cristiano-2026", offerGross: 2500, baseDescription: "LLC Formation - Domenico" }

  it("bills PART ONE at its own value — never the whole fee reduced later", () => {
    // Domenico's deal was executed by hand the other way round: one EUR2,500 invoice amended
    // down to EUR1,250. That was the only move available on an already-signed offer, and it is
    // explicitly NOT the model's behaviour — a part is minted at its own value.
    const bill = decideSigningBill({ ...base, rawPlan: DOMENICO_PLAN })
    expect(bill.amount).toBe(1250)
    expect(bill.tranche).toEqual({ offerToken: "domenico-cristiano-2026", seq: 1 })
    expect(bill.category).toBe("setup_tranche")
    expect(bill.planIgnored).toBe(null)
  })

  it("⛔ NEVER the annual instalment categories — paying one lifts the accountant hand-off gate", () => {
    const bill = decideSigningBill({ ...base, rawPlan: DOMENICO_PLAN })
    expect(bill.category).not.toBe("installment_1")
    expect(bill.category).not.toBe("installment_2")
  })

  it("describes the part on the invoice in Antonio's own wording", () => {
    const bill = decideSigningBill({ ...base, rawPlan: DOMENICO_PLAN })
    expect(bill.description).toBe("LLC Formation - Domenico — Partial Payment (part 1 of 2)")
    expect(bill.description.toLowerCase()).not.toContain("instalment")
  })

  it("an ordinary offer is untouched: whole fee, no lineage, no category", () => {
    const bill = decideSigningBill({ ...base, rawPlan: null })
    expect(bill.amount).toBe(2500)
    expect(bill.description).toBe("LLC Formation - Domenico")
    expect(bill.tranche).toBe(null)
    expect(bill.category).toBe(null)
    expect(bill.planIgnored).toBe(null)
  })

  it("a plan with nothing due on signing bills ZERO, not the commitment", () => {
    // Zero reaches decideInvoiceAtSigning, which raises no invoice — correct. Falling back to
    // the total here would bill a client for money that is not yet due.
    const bill = decideSigningBill({
      ...base,
      rawPlan: [
        { seq: 1, amount: 1250, currency: "EUR", trigger: { kind: "manual" } },
        { seq: 2, amount: 1250, currency: "EUR", trigger: { kind: "manual" } },
      ],
    })
    expect(bill.amount).toBe(0)
    expect(bill.tranche).toBe(null)
  })

  it("⛔ AN UNUSABLE PLAN STILL BILLS — the client has already signed", () => {
    // The signature is stored by the time this runs. Refusing to raise anything would leave a
    // signed deal with no bill at all, which is worse than a bill Antonio has to amend. The
    // fallback is today's exact behaviour, and the reason travels out for the log.
    const bill = decideSigningBill({
      ...base,
      rawPlan: [{ seq: 1, amount: 1250, currency: "EUR", trigger: { kind: "signing" } }],
    })
    expect(bill.amount).toBe(2500)
    expect(bill.tranche).toBe(null)
    expect(bill.category).toBe(null)
    expect(bill.planIgnored).toContain("single payment")
  })

  it("a mixed-currency plan is unusable, and says so rather than picking a part", () => {
    const bill = decideSigningBill({
      ...base,
      rawPlan: [
        { seq: 1, amount: 1250, currency: "EUR", trigger: { kind: "signing" } },
        { seq: 2, amount: 1250, currency: "USD", trigger: { kind: "manual" } },
      ],
    })
    expect(bill.amount).toBe(2500)
    expect(bill.planIgnored).toContain("ONE currency")
  })

  it("three parts bill only the first, and the description counts them honestly", () => {
    const bill = decideSigningBill({
      ...base,
      offerGross: 3000,
      rawPlan: [
        { seq: 1, amount: 1000, currency: "USD", trigger: { kind: "signing" } },
        { seq: 2, amount: 1000, currency: "USD", trigger: { kind: "event", event: "ein_received" } },
        { seq: 3, amount: 1000, currency: "USD", trigger: { kind: "manual" } },
      ],
    })
    expect(bill.amount).toBe(1000)
    expect(bill.description).toContain("part 1 of 3")
  })
})
