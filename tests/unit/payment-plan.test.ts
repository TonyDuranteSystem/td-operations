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
  WIRED_TRANCHE_EVENTS,
  clientFacingPartLabel,
  clientFacingSchedule,
  decideSigningBill,
  PARTIAL_PAYMENT_LABEL,
  refusePlanWithReferralPartner,
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
    trigger: { kind: "manual", label: "Bank account opened (Relay)" },
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
      { seq: 2, amount: 1000, currency: "USD", trigger: { kind: "manual", label: "EIN issued" } },
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
  it("stores the three trigger kinds that are real today", () => {
    // 'event' is deliberately NOT among them: nothing dispatches one, so it is refused rather
    // than stored — see the vocabulary block at the bottom of this file.
    for (const kind of ["signing", "date", "manual"] as const) {
      const part =
        kind === "date"
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
    expect(res.errors.join(" ")).toContain("nothing in the system fires an event yet")
    // The registry is empty ON PURPOSE, so an event trigger is refused rather than left waiting
    // for a dispatcher nobody wrote.
    expect(WIRED_TRANCHE_EVENTS).toHaveLength(0)
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

/**
 * The ban, as WHOLE WORDS.
 *
 * A plain substring check was wrong and a test caught it: the ordinary Italian word
 * "separatamente" contains "rata", so the guard fired on innocent copy. Word boundaries keep it
 * aimed at the renewal contract's vocabulary — "rata", "rate", "rateizzazione", "instalment",
 * "installment" — without banning every Italian word that happens to contain those letters.
 */
const BANNED_WORDS = /\b(rat[ae]|rateizzazion[ei]|instal?lments?)\b/i

describe("⛔ CLIENT-FACING WORDING — never 'instalment'", () => {
  const plan = validatePaymentPlan(DOMENICO_PLAN).plan!

  it("says what is due and when, in the client's terms", () => {
    expect(clientFacingPartLabel(plan[0], 2)).toBe("Part 1 of 2, due on signing")
    // The stored words render — Domenico's fixture label, verbatim (architect ruling 2026-08-11:
    // a generic "the agreed step" tells a client nothing about when they owe money).
    expect(clientFacingPartLabel(plan[1], 2)).toBe("Part 2 of 2, due Bank account opened (Relay)")
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

  it("renders the STORED words on a manual part — the label is client copy now", () => {
    // INVERTED 2026-08-11 by architect ruling: this cell used to assert the label NEVER reached
    // the client. The ruling made it client-visible ("a client reading 'the agreed step' learns
    // nothing about when they owe money"), and the field's doc now says to write it FOR the
    // client. The generic phrase survives only as the fallback for a part authored without one.
    const labelled = { seq: 2, amount: 1, currency: "USD", trigger: { kind: "manual" as const, label: "when your bank account is opened" } }
    expect(clientFacingPartLabel(labelled, 2)).toBe("Part 2 of 2, due when your bank account is opened")
    const bare = { seq: 2, amount: 1, currency: "USD", trigger: { kind: "manual" as const } }
    expect(clientFacingPartLabel(bare, 2)).toBe("Part 2 of 2, due when the agreed step is complete")
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
    expect(laterParts(plan)[0].trigger.label).toBe("Bank account opened (Relay)") // when it falls due
  })
})

describe("⛔ ENGLISH ONLY — Antonio's ruling, 2026-08-11", () => {
  // "I don't want a fucking nothing in italian. Luca and I work in english." This supersedes the
  // earlier Italian label approval. The banned-words guard STAYS armed — it costs nothing and it
  // stops the next session reintroducing what has now been ruled out twice.
  const plan = validatePaymentPlan(DOMENICO_PLAN).plan!

  it("every schedule line is English, on every offer", () => {
    for (const p of plan) {
      const label = clientFacingPartLabel(p, plan.length)
      expect(label).toMatch(/^Part \d+ of \d+, due /)
      expect(label.toLowerCase()).not.toMatch(BANNED_WORDS)
    }
  })

  it("a DATE part renders a human date, never raw ISO", () => {
    // "2026-09-01" to a client is wrong in any language. Format matches the offer pages' own
    // client-facing dates: day, month name, year, UTC.
    const dated = { seq: 2, amount: 1, currency: "EUR", trigger: { kind: "date" as const, date: "2026-09-01" } }
    expect(clientFacingPartLabel(dated, 2)).toBe("Part 2 of 2, due by 1 September 2026")
    expect(clientFacingPartLabel(dated, 2)).not.toContain("2026-09")
  })

  it("an unparseable date falls back to the raw string rather than 'Invalid Date'", () => {
    const odd = { seq: 2, amount: 1, currency: "EUR", trigger: { kind: "date" as const, date: "soon" } }
    expect(clientFacingPartLabel(odd, 2)).toBe("Part 2 of 2, due by soon")
  })
})

describe("clientFacingSchedule — one sentence per part, in order", () => {
  it("describes the whole agreement without formatting the money", () => {
    const plan = validatePaymentPlan(DOMENICO_PLAN).plan!
    const rows = clientFacingSchedule(plan)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ seq: 1, amount: 1250, currency: "EUR", label: "Part 1 of 2, due on signing" })
    expect(rows[1].label).toBe("Part 2 of 2, due Bank account opened (Relay)")
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
        { seq: 2, amount: 1000, currency: "USD", trigger: { kind: "manual", label: "EIN issued" } },
        { seq: 3, amount: 1000, currency: "USD", trigger: { kind: "manual" } },
      ],
    })
    expect(bill.amount).toBe(1000)
    expect(bill.description).toContain("part 1 of 3")
  })
})

describe("⛔ THE LABEL — English only (Antonio, 2026-08-11, superseding the Italian approval)", () => {
  it("is 'Partial Payment', a single string, no locale variants", () => {
    expect(PARTIAL_PAYMENT_LABEL).toBe("Partial Payment")
    expect(typeof PARTIAL_PAYMENT_LABEL).toBe("string")
  })

  it("never carries the renewal contract's vocabulary", () => {
    // The ban stays armed even though the Italian copy is gone: it has now been ruled out twice,
    // and the guard is what stops a third introduction.
    expect(PARTIAL_PAYMENT_LABEL.toLowerCase()).not.toMatch(BANNED_WORDS)
  })

  it("the invoice description uses the English label even for an Italian client", () => {
    // Deliberate: every invoice description in the system is English, and localising this one
    // line would make a single row of an Italian client's invoice list disagree with the rest.
    const plan = validatePaymentPlan(DOMENICO_PLAN).plan!
    expect(trancheInvoiceDescription(plan[1], 2, "LLC Formation")).toContain("Partial Payment")
    expect(trancheInvoiceDescription(plan[1], 2, "LLC Formation")).not.toContain("Pagamento")
  })
})

// ─── The trigger vocabulary tells the truth about what fires (architect ruling) ───

describe("⛔ an event trigger cannot promise a mechanism that does not exist", () => {
  it("refuses ANY event trigger while nothing in the system dispatches one", () => {
    // The registry is empty on purpose. A stored event name is a promise that something fires it,
    // and a later session finding one would build on that promise.
    const res = validatePaymentPlan([
      { seq: 1, amount: 1250, currency: "EUR", trigger: { kind: "signing" } },
      { seq: 2, amount: 1250, currency: "EUR", trigger: { kind: "event", event: "bank_account_opened" } },
    ])
    expect(res.ok).toBe(false)
    expect(res.errors.join(" ")).toContain("nothing in the system fires an event yet")
  })

  it("steers the author to the manual trigger instead of just saying no", () => {
    const res = validatePaymentPlan([
      { seq: 1, amount: 1250, currency: "EUR", trigger: { kind: "signing" } },
      { seq: 2, amount: 1250, currency: "EUR", trigger: { kind: "event", event: "ein_received" } },
    ])
    expect(res.errors.join(" ")).toContain("when you say so")
  })

  it("keeps the human's own words on a manual trigger — the bank-account case", () => {
    // "When the bank account opens" is Antonio's judgement, not a system state: formation no
    // longer creates a banking service delivery at all. It is stored as free text for that reason.
    const res = validatePaymentPlan([
      { seq: 1, amount: 1250, currency: "EUR", trigger: { kind: "signing" } },
      { seq: 2, amount: 1250, currency: "EUR", trigger: { kind: "manual", label: "Bank account opened (Relay)" } },
    ])
    expect(res.ok).toBe(true)
    expect(res.plan![1].trigger.label).toBe("Bank account opened (Relay)")
    expect(res.plan![1].trigger.event).toBeUndefined()
  })

  it("a manual part renders its stored words, and the ban still holds over them", () => {
    // The label is CLIENT COPY now (architect ruling 2026-08-11) — the author writes it for the
    // client, and the banned-vocabulary guard applies to what actually renders.
    const plan = validatePaymentPlan(DOMENICO_PLAN).plan!
    const line = clientFacingPartLabel(plan[1], 2)
    expect(line).toContain("Bank account opened")
    expect(line.toLowerCase()).not.toMatch(BANNED_WORDS)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
//  ⛔ A PLAN AND A REFERRER CANNOT SHARE AN OFFER (architect ruling)
//
//  Because activation credits the WHOLE commission on the first payment — the referral credit path
//  can only key one note per referral — a plan sold to a referred client would pay the partner in
//  full for money that has not arrived. Refused at authoring so the hand-settlement card stays a
//  safety net rather than the normal route.
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("a plan is refused on an offer that carries a referrer", () => {
  it("refuses when there is a referrer", () => {
    expect(refusePlanWithReferralPartner(true)).toBeTruthy()
  })

  it("says nothing at all when there is no referrer — the ordinary case stays silent", () => {
    expect(refusePlanWithReferralPartner(false)).toBeNull()
  })

  it("tells the author what to DO, not just that it is refused (R099)", () => {
    const msg = refusePlanWithReferralPartner(true)!
    expect(msg).toContain("drop the plan")
    expect(msg).toContain("by hand")
  })

  it("names the actual reason — the commission timing, not a vague policy", () => {
    expect(refusePlanWithReferralPartner(true)).toContain("credited in full on the first payment")
  })

  it("is English only and stays inside the banned-vocabulary guard", () => {
    // Staff-facing — and the client never learns a referrer exists, so there is no localised
    // variant to leak anywhere (Antonio, 2026-08-11).
    const msg = refusePlanWithReferralPartner(true)!
    expect(msg).toContain("Partial Payment")
    expect(msg.toLowerCase()).not.toMatch(BANNED_WORDS)
  })
})
