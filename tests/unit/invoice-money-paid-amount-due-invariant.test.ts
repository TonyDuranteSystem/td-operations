import { describe, it, expect } from "vitest"
import { resolveInvoiceStatusAfterPayment, resolveInvoiceStatusAfterReversal } from "@/lib/finance/invoice-money"

/**
 * The invariant this whole file exists to prove: a `payments` row can never
 * simultaneously read status='Paid' and amount_due>0. That contradiction is
 * exactly what dev job c2751393 found on 115 real production invoices
 * (totalling $121,880 before cleanup) -- an invoice claiming to be fully
 * settled while also claiming money was still owed.
 *
 * `resolveInvoiceStatusAfterPayment` is where that arithmetic actually
 * happens -- `lib/finance/apply-payment.ts` (the ONE money writer) always
 * writes `invoice_status`/`amount_paid`/`amount_due` together from this
 * function's own return value in one object literal (see its "coherent
 * tuple" comment), so proving the invariant holds here for every input
 * proves it holds for every real call site, by construction -- there is no
 * code path where the writer could take newStatus from one place and
 * newAmountDue from another.
 *
 * The OTHER known ways a `payments` row's status could reach 'Paid' each
 * have their own dedicated coverage already, referenced here rather than
 * duplicated:
 *  - Finance's total-edit / promote-to-Paid branch (a balance edit that
 *    brings amount_due to exactly 0, or reopens a Paid row when it doesn't):
 *    tests/unit/finance-update-invoice-amount-due.test.ts
 *  - Finance's own markInvoicePaid / the shared writer's settle_full mode
 *    on a bare/legacy payment: tests/unit/finance-mark-invoice-paid-bare-payment.test.ts
 *  - The old Payment Tracker page's markPaymentPaid/markInvoicePaid/voidInvoice
 *    (retired, neutered to an immediate refusal -- can no longer write
 *    anything at all): tests/unit/payments-page-actions-retired.test.ts
 *  - syncInvoiceStatus('payment', ...), the ORIGINAL 2026-07-14 root cause --
 *    now throws if asked to carry money at all:
 *    tests/unit/sync-invoice-status-cas.test.ts
 *  - The currency-mismatch guard that refuses rather than silently crediting
 *    a wrong-currency wire: tests/unit/apply-payment-currency-guard.test.ts
 */
describe("resolveInvoiceStatusAfterPayment — Paid ⟺ amount_due=0, for every input", () => {
  it("a full payment from zero settles exactly at 0 due", () => {
    const r = resolveInvoiceStatusAfterPayment(1000, 0, 1000)
    expect(r).toEqual({ newStatus: "Paid", newAmountPaid: 1000, newAmountDue: 0 })
  })

  it("a partial payment leaves a real balance and stays Partial", () => {
    const r = resolveInvoiceStatusAfterPayment(1000, 0, 300)
    expect(r).toEqual({ newStatus: "Partial", newAmountPaid: 300, newAmountDue: 700 })
  })

  it("a second payment that exactly completes the balance settles at 0 due", () => {
    const r = resolveInvoiceStatusAfterPayment(1000, 300, 700)
    expect(r).toEqual({ newStatus: "Paid", newAmountPaid: 1000, newAmountDue: 0 })
  })

  it("a payment larger than the remaining balance is capped, never negative amount_due", () => {
    // $650 wire against a $500 invoice -- the exact shape of the class of bug this
    // module's own header comment names as historically dangerous.
    const r = resolveInvoiceStatusAfterPayment(500, 0, 650)
    expect(r).toEqual({ newStatus: "Paid", newAmountPaid: 500, newAmountDue: 0 })
  })

  it("more money arriving on an already-fully-paid invoice stays capped at 0 due, not negative", () => {
    const r = resolveInvoiceStatusAfterPayment(1000, 1000, 50)
    expect(r).toEqual({ newStatus: "Paid", newAmountPaid: 1000, newAmountDue: 0 })
  })

  it("floating-point-prone cents still round cleanly and stay internally consistent", () => {
    // 0.1 + 0.2 is 0.30000000000000004 in raw JS float math -- this is exactly the
    // dust this function's own round2 helper exists to remove.
    const r = resolveInvoiceStatusAfterPayment(0.3, 0.1, 0.2)
    expect(r.newAmountPaid).toBe(0.3)
    expect(r.newAmountDue).toBe(0)
    expect(r.newStatus).toBe("Paid")
  })

  it("a zero-amount payment (should never reach this function per applyMoneyToInvoice's own zero_amount guard, tested defensively anyway) does not fabricate a settlement", () => {
    const r = resolveInvoiceStatusAfterPayment(1000, 400, 0)
    expect(r).toEqual({ newStatus: "Partial", newAmountPaid: 400, newAmountDue: 600 })
  })

  it("PROPERTY: across a wide sweep of realistic (total, alreadyPaid, newAmount) combinations, newStatus is 'Paid' if and only if newAmountDue is exactly 0 -- the actual invariant, not just spot examples", () => {
    const totals = [0.01, 1, 50, 99.99, 250, 500, 1000, 2500, 10000]
    const paidFractions = [0, 0.25, 0.5, 0.75, 1]
    const paymentAmounts = [0.01, 1, 50, 99.99, 250, 500, 1000, 2500, 10000]

    let casesChecked = 0
    for (const total of totals) {
      for (const frac of paidFractions) {
        const alreadyPaid = Math.round(total * frac * 100) / 100
        for (const payment of paymentAmounts) {
          const r = resolveInvoiceStatusAfterPayment(total, alreadyPaid, payment)
          casesChecked++

          // The invariant itself: these two facts can never disagree.
          expect(r.newStatus === "Paid").toBe(r.newAmountDue === 0)

          // Supporting properties that would let the invariant slip if broken.
          expect(r.newAmountDue).toBeGreaterThanOrEqual(0)
          expect(r.newAmountPaid).toBeLessThanOrEqual(total)
          expect(Math.round((r.newAmountPaid + r.newAmountDue) * 100) / 100).toBe(Math.round(total * 100) / 100)
        }
      }
    }
    expect(casesChecked).toBe(totals.length * paidFractions.length * paymentAmounts.length)
  })
})

describe("resolveInvoiceStatusAfterReversal — the reverse direction never leaves a Paid+due>0 row either", () => {
  it("PROPERTY: newStatus is 'Paid' if and only if newAmountDue is exactly 0, across a wide sweep", () => {
    const totals = [1, 50, 500, 1000, 5000]
    const currentPaidValues = [0, 50, 500, 1000, 5000]
    const creditedValues = [0, 1, 50, 500, 1000, 5000]

    for (const total of totals) {
      for (const currentPaid of currentPaidValues) {
        for (const credited of creditedValues) {
          const r = resolveInvoiceStatusAfterReversal(total, currentPaid, credited)
          if (r.newStatus === "Paid") {
            expect(r.newAmountDue).toBe(0)
          }
          if (r.newAmountDue === 0 && r.newAmountPaid > 0) {
            expect(r.newStatus).toBe("Paid")
          }
          expect(r.newAmountDue).toBeGreaterThanOrEqual(0)
          expect(r.newAmountPaid).toBeGreaterThanOrEqual(0)
        }
      }
    }
  })
})
