import { describe, it, expect } from "vitest"
import {
  capturePreVoidState,
  parsePreVoidState,
  resolveReactivateTarget,
  partitionFeedsForUnlink,
  reactivateBlocker,
  type PreVoidState,
} from "@/lib/billing/invoice-reactivate"
import { projectedReminderCount, daysPastDue } from "@/lib/billing/dunning"

describe("capturePreVoidState", () => {
  it("snapshots the live invoice state", () => {
    expect(
      capturePreVoidState({
        status: "Overdue",
        invoice_status: "Overdue",
        amount_due: 600,
        amount_paid: 0,
        paid_date: null,
      }),
    ).toEqual({ status: "Overdue", invoice_status: "Overdue", amount_due: 600, amount_paid: 0, paid_date: null, credit_remaining: null })
  })

  it("captures credit_remaining on a credit note", () => {
    const snap = capturePreVoidState({
      status: "Paid", invoice_status: "Credit", amount_due: 0, amount_paid: -200, paid_date: null, credit_remaining: 150,
    })
    expect(snap.credit_remaining).toBe(150)
  })

  it("defaults a null status to Pending/Draft rather than writing null", () => {
    const snap = capturePreVoidState({
      status: null, invoice_status: null, amount_due: null, amount_paid: null, paid_date: null,
    })
    expect(snap.status).toBe("Pending")
    expect(snap.invoice_status).toBe("Draft")
    expect(snap.amount_due).toBe(0)
  })

  it("rounds money to cents", () => {
    const snap = capturePreVoidState({
      status: "Pending", invoice_status: "Partial", amount_due: 0.1 + 0.2, amount_paid: 599.999, paid_date: null,
    })
    expect(snap.amount_due).toBe(0.3)
    expect(snap.amount_paid).toBe(600)
  })
})

describe("parsePreVoidState", () => {
  const good = { status: "Overdue", invoice_status: "Overdue", amount_due: 600, amount_paid: 0, paid_date: null, credit_remaining: null }

  it("reads a well-formed snapshot", () => {
    expect(parsePreVoidState({ pre_void_state: good })).toEqual(good)
  })

  it("returns null when the audit row has no snapshot (pre-fix cancellations)", () => {
    expect(parsePreVoidState({})).toBeNull()
    expect(parsePreVoidState(null)).toBeNull()
    expect(parsePreVoidState(undefined)).toBeNull()
    expect(parsePreVoidState("nonsense")).toBeNull()
  })

  it("refuses a snapshot that itself says Cancelled — that would strand the invoice", () => {
    expect(parsePreVoidState({ pre_void_state: { ...good, status: "Cancelled" } })).toBeNull()
    expect(parsePreVoidState({ pre_void_state: { ...good, invoice_status: "Cancelled" } })).toBeNull()
  })

  it("refuses a status that is not a real payments enum member", () => {
    expect(parsePreVoidState({ pre_void_state: { ...good, status: "Sent" } })).toBeNull()
    expect(parsePreVoidState({ pre_void_state: { ...good, status: "" } })).toBeNull()
  })

  it("refuses non-numeric money", () => {
    expect(parsePreVoidState({ pre_void_state: { ...good, amount_due: "six hundred" } })).toBeNull()
    expect(parsePreVoidState({ pre_void_state: { ...good, amount_paid: NaN } })).toBeNull()
  })

  it("preserves a paid_date string", () => {
    const withDate = { ...good, status: "Paid", invoice_status: "Paid", amount_due: 0, amount_paid: 600, paid_date: "2026-03-01" }
    expect(parsePreVoidState({ pre_void_state: withDate })?.paid_date).toBe("2026-03-01")
  })

  it("reads credit_remaining, and treats an old snapshot without it as null", () => {
    expect(parsePreVoidState({ pre_void_state: { ...good, credit_remaining: 150 } })?.credit_remaining).toBe(150)
    const legacy = { status: "Overdue", invoice_status: "Overdue", amount_due: 600, amount_paid: 0, paid_date: null }
    expect(parsePreVoidState({ pre_void_state: legacy })?.credit_remaining).toBeNull()
  })
})

describe("reactivateBlocker", () => {
  const prior: PreVoidState = {
    status: "Paid", invoice_status: "Credit", amount_due: 0, amount_paid: -200, paid_date: null, credit_remaining: 150,
  }

  it("allows an ordinary cancelled invoice", () => {
    expect(reactivateBlocker({ prior: null, total: 600, invoiceStatus: "Cancelled" })).toBeNull()
  })

  it("blocks a split parent", () => {
    expect(reactivateBlocker({ prior: null, total: 600, invoiceStatus: "Split" })).toContain("split parent")
  })

  it("blocks a credit note with no snapshot — its remaining credit is unrecoverable", () => {
    // Without this, a cancelled -$200 credit note came back as a $0 Draft
    // INVOICE. Caught by the live QA harness.
    expect(reactivateBlocker({ prior: null, total: -200, invoiceStatus: "Cancelled" })).toContain("credit note")
  })

  it("allows a credit note when the cancellation recorded its remaining credit", () => {
    expect(reactivateBlocker({ prior, total: -200, invoiceStatus: "Cancelled" })).toBeNull()
  })
})

describe("resolveReactivateTarget", () => {
  const today = "2026-07-10"

  it("restores the recorded snapshot verbatim when the void captured one", () => {
    const prior: PreVoidState = {
      status: "Pending", invoice_status: "Sent", amount_due: 600, amount_paid: 0, paid_date: null, credit_remaining: null,
    }
    const target = resolveReactivateTarget({ prior, total: 600, amountPaid: 0, dueDate: "2026-06-01", today, wasSent: true })
    expect(target).toEqual({ ...prior, source: "recorded" })
  })

  it("the recorded snapshot wins even when derivation would disagree", () => {
    // Past due, so derivation would say Overdue — but the void recorded Draft.
    const prior: PreVoidState = {
      status: "Pending", invoice_status: "Draft", amount_due: 600, amount_paid: 0, paid_date: null, credit_remaining: null,
    }
    const target = resolveReactivateTarget({ prior, total: 600, amountPaid: 0, dueDate: "2026-01-01", today, wasSent: false })
    expect(target.invoice_status).toBe("Draft")
    expect(target.source).toBe("recorded")
  })

  // ── Derivation (invoices cancelled before the snapshot existed) ──

  it("derives Overdue for a past-due unpaid invoice, even if never emailed", () => {
    // This is the VictoriamRoas INV-002218 case: never sent, 39 days past due,
    // and Antonio wants it back as a live overdue debt.
    const target = resolveReactivateTarget({
      prior: null, total: 600, amountPaid: 0, dueDate: "2026-06-01", today, wasSent: false,
    })
    expect(target).toEqual({
      status: "Overdue", invoice_status: "Overdue", amount_due: 600, amount_paid: 0, paid_date: null, credit_remaining: null, source: "derived",
    })
  })

  it("derives Paid when real cash already covers the total", () => {
    const target = resolveReactivateTarget({
      prior: null, total: 600, amountPaid: 600, dueDate: "2026-01-01", today, wasSent: true,
    })
    expect(target.status).toBe("Paid")
    expect(target.invoice_status).toBe("Paid")
    expect(target.amount_due).toBe(0)
  })

  it("treats an overpayment as Paid, never a negative balance", () => {
    const target = resolveReactivateTarget({
      prior: null, total: 600, amountPaid: 700, dueDate: null, today, wasSent: true,
    })
    expect(target.status).toBe("Paid")
    expect(target.amount_due).toBe(0)
  })

  it("derives Partial for a part-paid invoice that is not yet due", () => {
    const target = resolveReactivateTarget({
      prior: null, total: 600, amountPaid: 200, dueDate: "2026-12-01", today, wasSent: true,
    })
    expect(target.status).toBe("Pending")
    expect(target.invoice_status).toBe("Partial")
    expect(target.amount_due).toBe(400)
  })

  it("past due beats part-paid — a part-paid overdue invoice comes back Overdue", () => {
    const target = resolveReactivateTarget({
      prior: null, total: 600, amountPaid: 200, dueDate: "2026-06-01", today, wasSent: true,
    })
    expect(target.invoice_status).toBe("Overdue")
    expect(target.amount_due).toBe(400)
  })

  it("derives Sent for an emailed invoice that is not yet due", () => {
    const target = resolveReactivateTarget({
      prior: null, total: 600, amountPaid: 0, dueDate: "2026-12-01", today, wasSent: true,
    })
    expect(target.status).toBe("Pending")
    expect(target.invoice_status).toBe("Sent")
  })

  it("derives Draft for a never-emailed invoice that is not yet due", () => {
    const target = resolveReactivateTarget({
      prior: null, total: 600, amountPaid: 0, dueDate: "2026-12-01", today, wasSent: false,
    })
    expect(target.invoice_status).toBe("Draft")
  })

  it("derives Draft for a never-emailed invoice with no due date at all", () => {
    const target = resolveReactivateTarget({
      prior: null, total: 600, amountPaid: 0, dueDate: null, today, wasSent: false,
    })
    expect(target.invoice_status).toBe("Draft")
  })

  it("an invoice due exactly today is not yet overdue", () => {
    const target = resolveReactivateTarget({
      prior: null, total: 600, amountPaid: 0, dueDate: today, today, wasSent: true,
    })
    expect(target.invoice_status).toBe("Sent")
  })

  it("never carries a stale paid_date onto a derived unpaid invoice", () => {
    const target = resolveReactivateTarget({
      prior: null, total: 600, amountPaid: 0, dueDate: "2026-06-01", today, wasSent: false,
    })
    expect(target.paid_date).toBeNull()
  })

  it("restores a credit note's remaining credit from the snapshot", () => {
    const prior: PreVoidState = {
      status: "Paid", invoice_status: "Credit", amount_due: 0, amount_paid: -200, paid_date: null, credit_remaining: 150,
    }
    const target = resolveReactivateTarget({ prior, total: -200, amountPaid: -200, dueDate: null, today, wasSent: false })
    expect(target.invoice_status).toBe("Credit")
    expect(target.credit_remaining).toBe(150)
  })

  it("a derived target never claims to know a credit balance", () => {
    const target = resolveReactivateTarget({ prior: null, total: 600, amountPaid: 0, dueDate: null, today, wasSent: false })
    expect(target.credit_remaining).toBeNull()
  })
})

describe("partitionFeedsForUnlink", () => {
  it("resets only confirmed matches; leaves every other status alone", () => {
    // The three rows found on the real VictoriamRoas INV-001244.
    const { resetIds, clearIds } = partitionFeedsForUnlink([
      { id: "a", status: "unmatched" },
      { id: "b", status: "ignored" },
      { id: "c", status: "outgoing" },
      { id: "d", status: "matched" },
    ])
    expect(resetIds).toEqual(["d"])
    expect(clearIds).toEqual(["a", "b", "c"])
  })

  it("handles a null status as 'leave it alone'", () => {
    expect(partitionFeedsForUnlink([{ id: "a", status: null }])).toEqual({ resetIds: [], clearIds: ["a"] })
  })

  it("handles no linked feeds", () => {
    expect(partitionFeedsForUnlink([])).toEqual({ resetIds: [], clearIds: [] })
  })
})

describe("projectedReminderCount", () => {
  const cfg = { r1: 7, r2: 14, autoSendEnabled: true, accountPaused: false, invoiceStatus: "Overdue" }

  it("warns of TWO emails for a long-overdue invoice with no reminders — the VictoriamRoas trap", () => {
    expect(projectedReminderCount({ ...cfg, daysOverdue: 39, reminderCount: 0 })).toBe(2)
  })

  it("warns of one email when only the first threshold is passed", () => {
    expect(projectedReminderCount({ ...cfg, daysOverdue: 7, reminderCount: 0 })).toBe(1)
  })

  it("counts the remaining email when one reminder already went out", () => {
    expect(projectedReminderCount({ ...cfg, daysOverdue: 39, reminderCount: 1 })).toBe(1)
  })

  it("is silent once the 2-reminder cap is reached", () => {
    expect(projectedReminderCount({ ...cfg, daysOverdue: 39, reminderCount: 2 })).toBe(0)
  })

  it("is silent before the first threshold", () => {
    expect(projectedReminderCount({ ...cfg, daysOverdue: 3, reminderCount: 0 })).toBe(0)
  })

  it("is silent when automatic sending is switched off", () => {
    expect(projectedReminderCount({ ...cfg, autoSendEnabled: false, daysOverdue: 39, reminderCount: 0 })).toBe(0)
  })

  it("is silent when the client's reminders are paused", () => {
    expect(projectedReminderCount({ ...cfg, accountPaused: true, daysOverdue: 39, reminderCount: 0 })).toBe(0)
  })

  it("is silent for any status other than Overdue — the pass only picks Overdue", () => {
    for (const invoiceStatus of ["Draft", "Sent", "Partial", "Paid"]) {
      expect(projectedReminderCount({ ...cfg, invoiceStatus, daysOverdue: 39, reminderCount: 0 })).toBe(0)
    }
  })
})

describe("daysPastDue", () => {
  it("counts whole days past the due date", () => {
    expect(daysPastDue("2026-06-01", "2026-07-10")).toBe(39)
  })

  it("is zero on the due date itself", () => {
    expect(daysPastDue("2026-07-10", "2026-07-10")).toBe(0)
  })

  it("is negative before the due date", () => {
    expect(daysPastDue("2026-07-20", "2026-07-10")).toBe(-10)
  })

  it("is unaffected by month and year boundaries", () => {
    expect(daysPastDue("2025-12-31", "2026-01-01")).toBe(1)
  })
})
