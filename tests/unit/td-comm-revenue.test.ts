import { describe, it, expect } from 'vitest'
import {
  TD_COMM_PAYOUT_TYPE,
  PAYMENT_PAID_STATUS,
  PAYOUT_METHODS,
  reservesBalance,
  toAmount,
  earningAmount,
  isRecognized,
  clientHasPaid,
  isAvailable,
  computePartnerBalance,
  canRequestPayout,
  isValidPayoutTransition,
  clientPaidState,
  formatUsd,
  type RevenueEnrollment,
  type LinkedPayment,
  type TdCommPayout,
} from '@/lib/td-communication/revenue'

/* --------------------------------- fixtures -------------------------------- */

function enrollment(over: Partial<RevenueEnrollment> = {}): RevenueEnrollment {
  return {
    id: 'e1',
    status: 'approved',
    partner_amount_usd: 100,
    earning_locked_at: '2026-07-01T00:00:00Z',
    worker_partner_id: 'w1',
    client_payment_id: 'p1',
    client_paid_override_at: null,
    ...over,
  }
}
const paidInvoice: LinkedPayment = { id: 'p1', status: 'Paid', total: 500 }
const pendingInvoice: LinkedPayment = { id: 'p1', status: 'Pending', total: 500 }

/* --------------------------------- constants ------------------------------- */

describe('constants', () => {
  it('discriminator + paid status + methods', () => {
    expect(TD_COMM_PAYOUT_TYPE).toBe('td_comm')
    expect(PAYMENT_PAID_STATUS).toBe('Paid')
    expect(PAYOUT_METHODS).toEqual(['bank_transfer', 'credit_note', 'invoice_deduction'])
  })
})

/* ------------------------------ toAmount / earning ------------------------- */

describe('toAmount', () => {
  it('coerces numbers, numeric strings, null, undefined, NaN', () => {
    expect(toAmount(100)).toBe(100)
    expect(toAmount('250.50')).toBe(250.5)
    expect(toAmount(null)).toBe(0)
    expect(toAmount(undefined)).toBe(0)
    expect(toAmount('not-a-number')).toBe(0)
    expect(toAmount(Number.NaN)).toBe(0)
  })
  it('earningAmount reads partner_amount_usd, null → 0', () => {
    expect(earningAmount(enrollment({ partner_amount_usd: 300 }))).toBe(300)
    expect(earningAmount(enrollment({ partner_amount_usd: null }))).toBe(0)
    expect(earningAmount(enrollment({ partner_amount_usd: '300' }))).toBe(300)
  })
})

/* ------------------------------ reservesBalance --------------------------- */

describe('reservesBalance', () => {
  it('everything except rejected reserves', () => {
    for (const s of ['pending', 'manual_review', 'requested', 'approved', 'paid']) {
      expect(reservesBalance(s)).toBe(true)
    }
    expect(reservesBalance('rejected')).toBe(false)
    // conservative: unknown/null reserves (prevents overdraw)
    expect(reservesBalance(null)).toBe(true)
    expect(reservesBalance(undefined)).toBe(true)
  })
})

/* ------------------------------ isRecognized ------------------------------ */

describe('isRecognized', () => {
  it('locked and not cancelled → recognized', () => {
    expect(isRecognized(enrollment())).toBe(true)
  })
  it('not locked → not recognized (past work needs the backfill)', () => {
    expect(isRecognized(enrollment({ earning_locked_at: null }))).toBe(false)
  })
  it('cancelled → never recognized even if locked', () => {
    expect(isRecognized(enrollment({ status: 'cancelled' }))).toBe(false)
  })
  it('approved→revision stays recognized (recognized once)', () => {
    expect(isRecognized(enrollment({ status: 'revision' }))).toBe(true)
  })
})

/* ------------------------------ clientHasPaid ----------------------------- */

describe('clientHasPaid', () => {
  it('Paid invoice → true', () => {
    expect(clientHasPaid(enrollment(), paidInvoice)).toBe(true)
  })
  it('Pending invoice → false', () => {
    expect(clientHasPaid(enrollment(), pendingInvoice)).toBe(false)
  })
  it('no invoice → false', () => {
    expect(clientHasPaid(enrollment(), null)).toBe(false)
    expect(clientHasPaid(enrollment())).toBe(false)
  })
  it('admin override → true even with no/pending invoice', () => {
    const e = enrollment({ client_paid_override_at: '2026-07-02T00:00:00Z' })
    expect(clientHasPaid(e, null)).toBe(true)
    expect(clientHasPaid(e, pendingInvoice)).toBe(true)
  })
})

/* -------------------------------- isAvailable ----------------------------- */

describe('isAvailable', () => {
  it('recognized + paid → available', () => {
    expect(isAvailable(enrollment(), paidInvoice)).toBe(true)
  })
  it('recognized + unpaid → not available', () => {
    expect(isAvailable(enrollment(), pendingInvoice)).toBe(false)
  })
  it('not recognized + paid → not available', () => {
    expect(isAvailable(enrollment({ earning_locked_at: null }), paidInvoice)).toBe(false)
  })
})

/* --------------------------- computePartnerBalance ------------------------ */

describe('computePartnerBalance', () => {
  const pay = (m: Record<string, LinkedPayment>) => (e: RevenueEnrollment) =>
    e.client_payment_id ? m[e.client_payment_id] ?? null : null

  it('splits earned-waiting vs available, then subtracts payouts', () => {
    const enrollments = [
      enrollment({ id: 'a', partner_amount_usd: 100, client_payment_id: 'pa' }), // paid → available
      enrollment({ id: 'b', partner_amount_usd: 200, client_payment_id: 'pb' }), // pending → waiting
      enrollment({ id: 'c', partner_amount_usd: 50, status: 'cancelled' }), // excluded
      enrollment({ id: 'd', partner_amount_usd: 300, earning_locked_at: null }), // not recognized
    ]
    const payments = { pa: paidInvoice, pb: pendingInvoice }
    const payouts: TdCommPayout[] = [
      { id: 'x', amount: 40, status: 'paid' },
      { id: 'y', amount: 25, status: 'requested' },
      { id: 'z', amount: 999, status: 'rejected' }, // ignored
    ]
    const b = computePartnerBalance(enrollments, pay(payments), payouts)
    expect(b.availableGross).toBe(100)
    expect(b.earnedWaiting).toBe(200)
    expect(b.paidOut).toBe(40)
    expect(b.inRequest).toBe(25)
    expect(b.readyToWithdraw).toBe(100 - 40 - 25) // 35
  })

  it('override counts as available without a Paid invoice', () => {
    const e = enrollment({ id: 'o', partner_amount_usd: 500, client_payment_id: null, client_paid_override_at: '2026-07-02T00:00:00Z' })
    const b = computePartnerBalance([e], () => null, [])
    expect(b.availableGross).toBe(500)
    expect(b.readyToWithdraw).toBe(500)
  })

  it('refund after payout → readyToWithdraw goes negative (surfaced, not clamped here)', () => {
    // was available+paid-out, now the invoice was Cancelled → no longer available
    const e = enrollment({ id: 'r', partner_amount_usd: 100, client_payment_id: 'pr' })
    const payments = { pr: { id: 'pr', status: 'Cancelled', total: 500 } as LinkedPayment }
    const payouts: TdCommPayout[] = [{ id: 'x', amount: 100, status: 'paid' }]
    const b = computePartnerBalance([e], pay(payments), payouts)
    expect(b.availableGross).toBe(0)
    expect(b.readyToWithdraw).toBe(-100)
  })

  it('null amounts never produce NaN', () => {
    const e = enrollment({ partner_amount_usd: null, client_payment_id: 'pa' })
    const b = computePartnerBalance([e], () => paidInvoice, [])
    expect(b.availableGross).toBe(0)
    expect(Number.isNaN(b.readyToWithdraw)).toBe(false)
  })
})

/* ------------------------------ canRequestPayout -------------------------- */

describe('canRequestPayout', () => {
  const bal = (ready: number) => ({ earnedWaiting: 0, availableGross: 0, paidOut: 0, inRequest: 0, readyToWithdraw: ready })
  it('allows within balance, rejects overdraw / non-positive / negative balance', () => {
    expect(canRequestPayout(50, bal(100))).toBe(true)
    expect(canRequestPayout(100, bal(100))).toBe(true)
    expect(canRequestPayout(101, bal(100))).toBe(false)
    expect(canRequestPayout(0, bal(100))).toBe(false)
    expect(canRequestPayout(-10, bal(100))).toBe(false)
    expect(canRequestPayout(10, bal(-5))).toBe(false) // clamped to 0
    expect(canRequestPayout(Number.NaN, bal(100))).toBe(false)
  })
})

/* --------------------------- isValidPayoutTransition ---------------------- */

describe('isValidPayoutTransition', () => {
  it('requested/pending/manual_review → approved', () => {
    expect(isValidPayoutTransition('requested', 'approved')).toBe(true)
    expect(isValidPayoutTransition('pending', 'approved')).toBe(true)
    expect(isValidPayoutTransition('manual_review', 'approved')).toBe(true)
    expect(isValidPayoutTransition('paid', 'approved')).toBe(false)
  })
  it('only approved → paid', () => {
    expect(isValidPayoutTransition('approved', 'paid')).toBe(true)
    expect(isValidPayoutTransition('requested', 'paid')).toBe(false)
  })
  it('open or approved → rejected; paid/rejected cannot be rejected', () => {
    expect(isValidPayoutTransition('requested', 'rejected')).toBe(true)
    expect(isValidPayoutTransition('approved', 'rejected')).toBe(true)
    expect(isValidPayoutTransition('paid', 'rejected')).toBe(false)
    expect(isValidPayoutTransition('rejected', 'rejected')).toBe(false)
  })
})

/* ------------------------------ clientPaidState --------------------------- */

describe('clientPaidState', () => {
  it('unbilled / unpaid / paid', () => {
    expect(clientPaidState(null)).toBe('unbilled')
    expect(clientPaidState(undefined)).toBe('unbilled')
    expect(clientPaidState(pendingInvoice)).toBe('unpaid')
    expect(clientPaidState(paidInvoice)).toBe('paid')
  })
})

/* --------------------------------- formatUsd ------------------------------ */

describe('formatUsd', () => {
  it('formats USD, handles null/strings', () => {
    expect(formatUsd(1250)).toBe('$1,250.00')
    expect(formatUsd('1000')).toBe('$1,000.00')
    expect(formatUsd(null)).toBe('$0.00')
  })
})
