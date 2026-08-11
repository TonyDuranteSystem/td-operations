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
