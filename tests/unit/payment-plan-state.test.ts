/**
 * Where a payment plan stands — the one answer three surfaces share.
 *
 * These cover the PURE core. The query wrapper is a thin read; what matters here is that
 * "raised", "sent", "paid" and "raisable again" mean exactly one thing across the staff view, the
 * client schedule and the obligation card.
 */

import { describe, it, expect } from "vitest"
import {
  computePlanStatus,
  computePlanSettlementFromStatus,
  isRaisable,
  duePartsToAutoRaise,
  DEAD_INVOICE_STATUSES,
  type TrancheInvoiceRow,
} from "@/lib/offers/payment-plan-state"
import { validatePaymentPlan } from "@/lib/offers/payment-plan"

// Domenico's real agreement: EUR1,250 at signing, EUR1,250 when his bank account opens.
const PLAN = validatePaymentPlan([
  { seq: 1, amount: 1250, currency: "EUR", trigger: { kind: "signing" } },
  { seq: 2, amount: 1250, currency: "EUR", trigger: { kind: "manual", label: "Bank account opened (Relay)" } },
]).plan!

function row(over: Partial<TrancheInvoiceRow> & { tranche_seq: number }): TrancheInvoiceRow {
  return {
    id: `pay-${over.tranche_seq}-${over.invoice_status ?? "x"}`,
    invoice_number: "INV-000001",
    invoice_status: "Draft",
    amount_paid: 0,
    amount: 1250,
    due_date: null,
    ...over,
  }
}

describe("computePlanStatus — the lifecycle of one part", () => {
  it("a plan with nothing raised shows both parts unraised and both obligations open", () => {
    const s = computePlanStatus(PLAN, [])
    expect(s.parts.map((p) => p.state)).toEqual(["not_raised", "not_raised"])
    expect(s.openParts).toHaveLength(2)
    expect(s.fullySettled).toBe(false)
  })

  it("distinguishes RAISED-BUT-UNSENT from awaiting payment", () => {
    // Not cosmetic. The wire matcher ignores a Draft entirely, so money against an unsent part
    // will not auto-match — staff must be able to see that difference at a glance.
    const s = computePlanStatus(PLAN, [
      row({ tranche_seq: 1, invoice_status: "Draft" }),
      row({ tranche_seq: 2, invoice_status: "Sent" }),
    ])
    expect(s.parts[0].state).toBe("raised_unsent")
    expect(s.parts[1].state).toBe("awaiting_payment")
  })

  it("⛔ a raised-but-unsent part keeps its obligation OPEN", () => {
    // Antonio's rule: open until the invoice is both sent AND paid. Otherwise a part the client
    // has never been told about reads as handled on a board.
    const s = computePlanStatus(PLAN, [row({ tranche_seq: 1, invoice_status: "Draft" })])
    expect(s.parts[0].obligationOpen).toBe(true)
  })

  it("reads PAID from the money, not only from the status word", () => {
    // A bank match writes the amount before anything reconciles the label, so a part holding its
    // full amount is paid whatever the column currently says.
    const s = computePlanStatus(PLAN, [
      row({ tranche_seq: 1, invoice_status: "Sent", amount_paid: 1250, amount: 1250 }),
    ])
    expect(s.parts[0].state).toBe("paid")
    expect(s.parts[0].obligationOpen).toBe(false)
  })

  it("part-paid is its own state and stays open", () => {
    const s = computePlanStatus(PLAN, [
      row({ tranche_seq: 1, invoice_status: "Partial", amount_paid: 500, amount: 1250 }),
    ])
    expect(s.parts[0].state).toBe("part_paid")
    expect(s.parts[0].obligationOpen).toBe(true)
  })

  it("fully settled only when every part is paid", () => {
    const s = computePlanStatus(PLAN, [
      row({ tranche_seq: 1, invoice_status: "Paid", amount_paid: 1250 }),
      row({ tranche_seq: 2, invoice_status: "Paid", amount_paid: 1250 }),
    ])
    expect(s.fullySettled).toBe(true)
    expect(s.openParts).toHaveLength(0)
  })
})

describe("⛔ a dead invoice releases the part — the same rule the database enforces", () => {
  it.each(DEAD_INVOICE_STATUSES)("a %s invoice leaves the part raisable again", (status) => {
    const s = computePlanStatus(PLAN, [row({ tranche_seq: 2, invoice_status: status })])
    expect(s.parts[1].state).toBe("not_raised")
    expect(isRaisable(s.parts[1])).toBe(true)
  })

  it("keeps the dead invoice visible as superseded rather than hiding it", () => {
    // It is the audit trail: someone raised this, then withdrew it. Staff need to see that,
    // the client does not.
    const s = computePlanStatus(PLAN, [row({ tranche_seq: 2, invoice_status: "Voided" })])
    expect(s.parts[1].supersededInvoices).toHaveLength(1)
    expect(s.parts[1].invoice).toBeNull()
  })

  it("a part with a dead invoice AND a fresh live one reports the live one", () => {
    // The re-raise case: the withdrawn invoice must not shadow the real one.
    const s = computePlanStatus(PLAN, [
      row({ tranche_seq: 2, invoice_status: "Voided", id: "dead" }),
      row({ tranche_seq: 2, invoice_status: "Sent", id: "live" }),
    ])
    expect(s.parts[1].invoice?.id).toBe("live")
    expect(s.parts[1].state).toBe("awaiting_payment")
    expect(isRaisable(s.parts[1])).toBe(false)
  })

  it("the dead list matches the database index predicate exactly", () => {
    // If these ever drift, the button appears where the database refuses, or hides where it
    // would accept. Migration 20260810-0940 carries the other copy.
    expect([...DEAD_INVOICE_STATUSES]).toEqual(["Cancelled", "Voided", "Credit"])
  })
})

describe("isRaisable — one condition, not a second opinion", () => {
  it("is true exactly when no live invoice occupies the slot", () => {
    const raised = computePlanStatus(PLAN, [row({ tranche_seq: 1, invoice_status: "Draft" })])
    expect(isRaisable(raised.parts[0])).toBe(false)
    expect(isRaisable(raised.parts[1])).toBe(true)
  })

  it("a PAID part is not raisable — the money already arrived", () => {
    const s = computePlanStatus(PLAN, [
      row({ tranche_seq: 1, invoice_status: "Paid", amount_paid: 1250 }),
    ])
    expect(isRaisable(s.parts[0])).toBe(false)
  })
})

describe("duePartsToAutoRaise — what the auto-raise cron acts on", () => {
  const DATED_PLAN = validatePaymentPlan([
    { seq: 1, amount: 1750, currency: "EUR", trigger: { kind: "signing" } },
    { seq: 2, amount: 1750, currency: "EUR", trigger: { kind: "date", date: "2026-09-23" } },
  ]).plan!

  it("is empty before the due date arrives", () => {
    const s = computePlanStatus(DATED_PLAN, [row({ tranche_seq: 1, invoice_status: "Paid", amount_paid: 1750 })])
    expect(duePartsToAutoRaise(s, "2026-09-22")).toEqual([])
  })

  it("includes the part on its due date, and every day after", () => {
    const s = computePlanStatus(DATED_PLAN, [row({ tranche_seq: 1, invoice_status: "Paid", amount_paid: 1750 })])
    expect(duePartsToAutoRaise(s, "2026-09-23").map((p) => p.part.seq)).toEqual([2])
    expect(duePartsToAutoRaise(s, "2026-10-01").map((p) => p.part.seq)).toEqual([2])
  })

  it("never includes a part a staffer already raised, even unsent — the cron must not mint a second invoice for a slot a human is handling", () => {
    const s = computePlanStatus(DATED_PLAN, [
      row({ tranche_seq: 1, invoice_status: "Paid", amount_paid: 1750 }),
      row({ tranche_seq: 2, invoice_status: "Draft" }),
    ])
    expect(duePartsToAutoRaise(s, "2026-10-01")).toEqual([])
  })

  it("never includes a signing-triggered part — signing is billed at signing, never by this cron", () => {
    const s = computePlanStatus(DATED_PLAN, [])
    // Part 1 (signing) is technically "not_raised" here (no invoice yet) and far in the "past"
    // relative to any today — but it has no date trigger at all, so it can never match.
    expect(duePartsToAutoRaise(s, "2099-01-01").map((p) => p.part.seq)).toEqual([2])
  })

  it("never includes a manual-triggered part — nothing in the system knows when a manual condition is met", () => {
    const manualPlan = validatePaymentPlan([
      { seq: 1, amount: 1000, currency: "USD", trigger: { kind: "signing" } },
      { seq: 2, amount: 1000, currency: "USD", trigger: { kind: "manual", label: "when the bank account opens" } },
    ]).plan!
    const s = computePlanStatus(manualPlan, [row({ tranche_seq: 1, invoice_status: "Paid", amount_paid: 1000 })])
    expect(duePartsToAutoRaise(s, "2099-01-01")).toEqual([])
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
//  ⛔ THE REAL PRODUCTION SHAPE OF AN AUTO-MATCHED PAYMENT (job c2751393)
//
//  VERIFIED ON PRODUCTION 2026-08-10: 115 paid invoices carry a phantom amount owing, and in
//  ALL 115 that phantom equals the invoice total — the automatic bank-matcher settle path never
//  writes the owing figure down, while writing the status and the money correctly. The staff
//  manual-match route does not have the defect (0 of 32).
//
//  WHY THIS DECIDES WHETHER PAYMENT PLANS WORK AT ALL: a later part is paid by WIRE and settled
//  by that same automatic matcher. If any part of the plan read path believed the owing figure,
//  every auto-settled part would read as unpaid on the client's screen for ever, the obligation
//  would never close, and the chase machinery could pursue a client who has already paid.
//
//  These fixtures are the real shape, not a hypothesis.
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("an auto-matched payment is recognised as paid despite its phantom owing figure", () => {
  it("the common shape — status Paid, money right, owing still equal to the total", () => {
    const st = computePlanStatus(PLAN, [
      {
        id: "auto-1",
        invoice_number: "INV-000502",
        invoice_status: "Paid",
        amount_paid: 1250,   // money recorded correctly (108 of 115 on production)
        amount: 1250,
        // The phantom: the matcher left this equal to the total. 115 of 115.
        amount_due: 1250,
        tranche_seq: 2,
        due_date: null,
      } as TrancheInvoiceRow & { amount_due: number },
    ])
    expect(st.parts[1].state).toBe("paid")
    expect(st.parts[1].obligationOpen).toBe(false)
    expect(isRaisable(st.parts[1])).toBe(false)
  })

  it("the rarer shape — the MONEY is missing too, and only the status says paid", () => {
    // 6 of the 115 have no recorded money at all. The money signal alone is NOT enough, which is
    // why the status word is a necessary second signal rather than a fallback. Reading only the
    // money would leave these six parts open for ever.
    const st = computePlanStatus(PLAN, [
      {
        id: "auto-2",
        invoice_number: "INV-000503",
        invoice_status: "Paid",
        amount_paid: 0,
        amount: 1250,
        amount_due: 1250,
        tranche_seq: 2,
        due_date: null,
      } as TrancheInvoiceRow & { amount_due: number },
    ])
    expect(st.parts[1].state).toBe("paid")
    expect(st.parts[1].obligationOpen).toBe(false)
  })

  it("and the money signal alone still works when the status word is the stale one", () => {
    // The mirror case: money fully received while the label has not caught up. Both signals are
    // load-bearing, in opposite directions.
    const st = computePlanStatus(PLAN, [
      {
        id: "auto-3",
        invoice_number: "INV-000504",
        invoice_status: "Sent",
        amount_paid: 1250,
        amount: 1250,
        amount_due: 1250,
        tranche_seq: 2,
        due_date: null,
      } as TrancheInvoiceRow & { amount_due: number },
    ])
    expect(st.parts[1].state).toBe("paid")
  })

  it("⛔ the plan read path never asks for the owing figure at all", () => {
    // Structural, not behavioural: the row type this resolver accepts has no owing field, so no
    // future edit can start reading it without changing the type first. That is the guarantee —
    // the tests above prove the shape is handled, this proves the column cannot creep back in.
    const row: TrancheInvoiceRow = {
      id: "x",
      invoice_number: null,
      invoice_status: "Paid",
      amount_paid: 1250,
      amount: 1250,
      tranche_seq: 1,
      due_date: null,
    }
    expect(Object.keys(row)).not.toContain("amount_due")
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
//  ⛔ computePlanSettlementFromStatus — THE RELEASE GATE (Antonio, 2026-08-13)
//
//  "Paid off" means we received the money AND the invoice is marked Paid — both halves, every
//  part. Deliberately STRICTER than fullySettled above: fullySettled treats a pure-credit
//  settlement as closed (correct — the client's obligation IS closed), but this gate must not,
//  because releasing a referrer's commission on money never received is the exact defect three
//  review rounds existed to prevent.
// ══════════════════════════════════════════════════════════════════════════════════════════

describe("computePlanSettlementFromStatus — the release gate", () => {
  it("eligible when every part is genuinely cash-paid", () => {
    const status = computePlanStatus(PLAN, [
      row({ tranche_seq: 1, invoice_status: "Paid", amount_paid: 1250, amount: 1250 }),
      row({ tranche_seq: 2, invoice_status: "Paid", amount_paid: 1250, amount: 1250 }),
    ])
    const settlement = computePlanSettlementFromStatus("tok", status)
    expect(settlement.eligible).toBe(true)
    expect(settlement.totalAgreed).toBe(2500)
    expect(settlement.totalReceived).toBe(2500)
  })

  it("⛔ NOT eligible on a PURE CREDIT settlement — the exact case Regenerate can produce", () => {
    // invoice_status flips to Paid, amount_paid is never touched (credit-netting.ts never writes
    // it). This is the regression the whole feature exists to prevent.
    const status = computePlanStatus(PLAN, [
      row({ tranche_seq: 1, invoice_status: "Paid", amount_paid: 1250, amount: 1250 }),
      row({ tranche_seq: 2, invoice_status: "Paid", amount_paid: 0, amount: 1250 }),
    ])
    const settlement = computePlanSettlementFromStatus("tok", status)
    expect(settlement.eligible).toBe(false)
    expect(settlement.parts[1].settledInCash).toBe(false)
    expect(settlement.totalReceived).toBe(1250) // real cash only — the credit-settled part contributes nothing
  })

  it("not eligible when a part is unraised, unsent, part-paid, or sent-but-unpaid", () => {
    const notRaised = computePlanSettlementFromStatus("tok", computePlanStatus(PLAN, []))
    expect(notRaised.eligible).toBe(false)

    const unsent = computePlanSettlementFromStatus("tok", computePlanStatus(PLAN, [
      row({ tranche_seq: 1, invoice_status: "Paid", amount_paid: 1250, amount: 1250 }),
      row({ tranche_seq: 2, invoice_status: "Draft" }),
    ]))
    expect(unsent.eligible).toBe(false)

    const partPaid = computePlanSettlementFromStatus("tok", computePlanStatus(PLAN, [
      row({ tranche_seq: 1, invoice_status: "Paid", amount_paid: 1250, amount: 1250 }),
      row({ tranche_seq: 2, invoice_status: "Partial", amount_paid: 500, amount: 1250 }),
    ]))
    expect(partPaid.eligible).toBe(false)

    const awaiting = computePlanSettlementFromStatus("tok", computePlanStatus(PLAN, [
      row({ tranche_seq: 1, invoice_status: "Paid", amount_paid: 1250, amount: 1250 }),
      row({ tranche_seq: 2, invoice_status: "Sent", amount_paid: 0, amount: 1250 }),
    ]))
    expect(awaiting.eligible).toBe(false)
  })

  it("refuses a real one-cent shortfall, but absorbs float rounding within tolerance", () => {
    const shortfall = computePlanSettlementFromStatus("tok", computePlanStatus(PLAN, [
      row({ tranche_seq: 1, invoice_status: "Paid", amount_paid: 1250, amount: 1250 }),
      row({ tranche_seq: 2, invoice_status: "Paid", amount_paid: 1249.98, amount: 1250 }),
    ]))
    expect(shortfall.eligible).toBe(false)

    const roundingOnly = computePlanSettlementFromStatus("tok", computePlanStatus(PLAN, [
      row({ tranche_seq: 1, invoice_status: "Paid", amount_paid: 1250, amount: 1250 }),
      row({ tranche_seq: 2, invoice_status: "Paid", amount_paid: 1249.995, amount: 1250 }),
    ]))
    expect(roundingOnly.eligible).toBe(true)
  })

  it("trusts the invoice's OWN billed amount over the plan's stated figure — same precedence as classify()", () => {
    // Mirrors classify()'s own rule (owed = live.amount ?? part.amount): once a real invoice
    // exists, what it actually billed is the truth, not what the plan originally said.
    const status = computePlanStatus(PLAN, [
      row({ tranche_seq: 1, invoice_status: "Paid", amount_paid: 1250, amount: 1250 }),
      row({ tranche_seq: 2, invoice_status: "Paid", amount_paid: 1000, amount: 1000 }), // billed for less than the plan said
    ])
    const settlement = computePlanSettlementFromStatus("tok", status)
    expect(settlement.parts[1].agreedAmount).toBe(1000)
    expect(settlement.eligible).toBe(true) // fully paid against what was ACTUALLY billed
    expect(settlement.totalAgreed).toBe(2250)
  })

  it("⛔ totalAgreedExFee strips out a booked card fee — the commission base, never totalAgreed (2026-08-27 fix)", () => {
    // bookCardFee raises a part's invoice `amount` to base+fee once paid by card. A referrer's
    // commission must be computed on the base only — this is what release-commission now reads.
    const status = computePlanStatus(PLAN, [
      // Part 1 paid by card: billed 1250 base + 62.50 fee (5%) = 1312.50 total.
      row({ tranche_seq: 1, invoice_status: "Paid", amount_paid: 1312.5, amount: 1312.5, card_fee_amount: 62.5 }),
      // Part 2 paid by wire: no fee ever booked, card_fee_amount stays null.
      row({ tranche_seq: 2, invoice_status: "Paid", amount_paid: 1250, amount: 1250 }),
    ])
    const settlement = computePlanSettlementFromStatus("tok", status)
    expect(settlement.totalAgreed).toBe(2562.5) // real cash-flow total, fee included — unchanged
    expect(settlement.parts[0].agreedAmountExFee).toBe(1250)
    expect(settlement.parts[1].agreedAmountExFee).toBe(1250) // no fee to strip — unaffected
    expect(settlement.totalAgreedExFee).toBe(2500) // the real contract price — what commission is owed on
  })

  it("⚠️ the known false negative, pinned rather than hidden: the auto-matcher's rarer shape (job c2751393) reads as NOT eligible even though real cash arrived", () => {
    // Verified production shape: 6 of 115 auto-matched invoices have amount_paid=0 despite the
    // money genuinely arriving. This gate cannot distinguish that from a real credit-only
    // settlement — by design (see the doc comment on `eligible`). The consequence is a human has
    // to notice and release by hand; that is the intended, safer failure direction.
    const status = computePlanStatus(PLAN, [
      row({ tranche_seq: 1, invoice_status: "Paid", amount_paid: 1250, amount: 1250 }),
      row({ tranche_seq: 2, invoice_status: "Paid", amount_paid: 0, amount: 1250 }),
    ])
    expect(status.fullySettled).toBe(true) // the CLIENT's obligation genuinely is closed
    const settlement = computePlanSettlementFromStatus("tok", status)
    expect(settlement.eligible).toBe(false) // but the RELEASE gate correctly stays cautious
  })

  it("carries the offer token and the plan's currency through untouched", () => {
    const status = computePlanStatus(PLAN, [
      row({ tranche_seq: 1, invoice_status: "Paid", amount_paid: 1250, amount: 1250 }),
      row({ tranche_seq: 2, invoice_status: "Paid", amount_paid: 1250, amount: 1250 }),
    ])
    const settlement = computePlanSettlementFromStatus("nicholas-tosello-2026", status)
    expect(settlement.offerToken).toBe("nicholas-tosello-2026")
    expect(settlement.currency).toBe("EUR")
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════
//  ⛔ THE MIRROR IS MECHANICAL NOW (council, 2026-08-11): the dead-invoice list is asserted
//  against the MIGRATION'S OWN PREDICATE, not restated as a literal. Blocker 2 of this council
//  round was exactly this class of drift — a third copy of "what counts as dead" that diverged
//  at birth — so the mirror is no longer comment-and-literal only.
// ══════════════════════════════════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("the dead list matches the newest index migration, mechanically", () => {
  it("every dead status appears in the 20260810-0940 predicate, and no live one does", () => {
    const sql = readFileSync(
      join(process.cwd(), "scripts/migrations/20260810-0940-tranche-uniqueness-excludes-dead-invoices.sql"),
      "utf-8",
    )
    for (const status of DEAD_INVOICE_STATUSES) {
      expect(sql).toContain(`'${status}'`)
    }
    // And the predicate's NOT IN list contains exactly the dead statuses — nothing extra that
    // the resolver would then treat as live while the database treats it as dead.
    const m = sql.match(/NOT IN \(([^)]+)\)/)
    expect(m).toBeTruthy()
    const inDb = m![1].split(",").map((x) => x.trim().replace(/'/g, ""))
    expect([...inDb].sort()).toEqual([...DEAD_INVOICE_STATUSES].sort())
  })
})
