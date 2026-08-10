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
  isRaisable,
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
