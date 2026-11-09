import { describe, it, expect } from 'vitest'
import { balanceOwed, invoiceBaseExFee, MIN_CARD_CHARGE } from '@/lib/payments/card-fee'
import { buildCardQuote, stripeProductName, type QuotePayment } from '@/lib/payments/card-quote'

/** A normal open invoice: $1,000, nothing paid. */
function invoice(over: Partial<QuotePayment> = {}): QuotePayment {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    account_id: 'acc',
    contact_id: null,
    description: 'Annual renewal',
    invoice_number: 'INV-000001',
    amount: 1000,
    total: 1000,
    amount_paid: null,
    card_fee_amount: null,
    amount_currency: 'USD',
    status: 'Pending',
    invoice_status: 'Sent',
    card_fee_rate: 0.05,
    ...over,
  }
}

describe('balanceOwed (what is still owed on the invoice itself)', () => {
  it('is the whole base when nothing is paid', () => {
    expect(balanceOwed(1000, null)).toBe(1000)
    expect(balanceOwed(1000, 0)).toBe(1000)
    expect(balanceOwed('1000', undefined)).toBe(1000)
  })
  it('subtracts what was already paid', () => {
    expect(balanceOwed(1000, 500)).toBe(500)
    expect(balanceOwed(1000, '400.50')).toBe(599.5)
  })
  it('never goes below zero (over-paid or fully paid)', () => {
    expect(balanceOwed(1000, 1000)).toBe(0)
    expect(balanceOwed(1000, 1200)).toBe(0)
  })
  it('treats a negative paid figure (credit notes) as nothing paid', () => {
    expect(balanceOwed(1000, -250)).toBe(1000)
  })
  it('is cent-accurate (no float dust)', () => {
    expect(balanceOwed(0.3, 0.1)).toBe(0.2)
    expect(balanceOwed(100, 33.33)).toBe(66.67)
  })
  it('garbage in gives 0, never NaN', () => {
    expect(balanceOwed('abc', 5)).toBe(0)
    expect(balanceOwed(null, null)).toBe(0)
  })
})

describe('invoiceBaseExFee (the invoice TOTAL without the card fee — never the line items)', () => {
  it('is the total when no fee was booked', () => {
    expect(invoiceBaseExFee({ total: 1000, amount: 1000, card_fee_amount: null })).toBe(1000)
  })
  it('takes the total, so a discount / tax / payment-plan part is exactly what the client was told', () => {
    // $1,000 of lines with a $100 discount → total 900; a $50 invoice with tax → total 52.50;
    // a payment-plan part whose lines are the whole $2,500 setup fee but whose total is $1,250.
    expect(invoiceBaseExFee({ total: 900, amount: 900 })).toBe(900)
    expect(invoiceBaseExFee({ total: 52.5, amount: 52.5 })).toBe(52.5)
    expect(invoiceBaseExFee({ total: 1250, amount: 1250 })).toBe(1250)
  })
  it('removes a fee already booked, so a re-booking never compounds', () => {
    expect(invoiceBaseExFee({ total: 1050, amount: 1050, card_fee_amount: 50 })).toBe(1000)
  })
  it('after a crash between the fee line and the total bump the total is still unbumped and card_fee_amount empty → base is the total', () => {
    expect(invoiceBaseExFee({ total: 1000, amount: 1000, card_fee_amount: null })).toBe(1000)
  })
  it('falls back to amount when total is missing, and to 0 on garbage', () => {
    expect(invoiceBaseExFee({ total: null, amount: 800 })).toBe(800)
    expect(invoiceBaseExFee({ total: 'abc', amount: 5 })).toBe(0)
    expect(invoiceBaseExFee({})).toBe(0)
  })
  it('a fee larger than the total never makes it negative', () => {
    expect(invoiceBaseExFee({ total: 10, card_fee_amount: 50 })).toBe(0)
  })
})

describe('buildCardQuote — the one place the card price is decided', () => {
  it('ordinary invoice, nothing paid: whole invoice + 5% (unchanged from before)', () => {
    const q = buildCardQuote(invoice(), 0.05)
    expect(q.ok).toBe(true)
    if (q.ok === false) return
    expect(q.balance).toBe(1000)
    expect(q.fee).toBe(50)
    expect(q.cardTotal).toBe(1050)
    expect(q.alreadyPaid).toBe(0)
  })

  it('PART-PAID: $1,000 invoice, $500 already wired → the card pays $500 + 5% = $525', () => {
    const q = buildCardQuote(invoice({ amount_paid: 500, invoice_status: 'Partial' }), 0.05)
    expect(q.ok).toBe(true)
    if (q.ok === false) return
    expect(q.invoiceTotal).toBe(1000)
    expect(q.alreadyPaid).toBe(500)
    expect(q.balance).toBe(500)
    expect(q.fee).toBe(25)
    expect(q.cardTotal).toBe(525)
  })

  it('the example from the bug: $150 invoice, $100 paid → $52.50, not $157.50', () => {
    const q = buildCardQuote(invoice({ amount: 150, total: 150, amount_paid: 100, invoice_status: 'Partial' }), 0.05)
    expect(q.ok && q.cardTotal).toBe(52.5)
  })

  it('DISCOUNTED invoice ($1,000 of lines, $100 discount, total $900): charges on the $900 the client was told, not on the lines', () => {
    const q = buildCardQuote(invoice({ amount: 900, total: 900 }), 0.05)
    expect(q.ok && q.balance).toBe(900)
    expect(q.ok && q.cardTotal).toBe(945)
  })

  it('discounted AND part-paid: total $900, $400 wired → $500 + 5% = $525', () => {
    const q = buildCardQuote(invoice({ amount: 900, total: 900, amount_paid: 400, invoice_status: 'Partial' }), 0.05)
    expect(q.ok && q.cardTotal).toBe(525)
  })

  it('PAYMENT-PLAN part (lines are the whole $2,500 fee, total is this part\'s $1,250): charges $1,312.50, not $2,625', () => {
    const q = buildCardQuote(invoice({ amount: 1250, total: 1250 }), 0.05)
    expect(q.ok && q.cardTotal).toBe(1312.5)
  })

  it('an invoice that already carries a booked fee never compounds it', () => {
    const q = buildCardQuote(invoice({ amount: 1050, total: 1050, card_fee_amount: 50, amount_paid: 500, invoice_status: 'Partial' }), 0.05)
    expect(q.ok && q.balance).toBe(500)
  })

  it('follows the rate it is given — nothing hardcoded (4% pin, fee switch off = 0)', () => {
    const at4 = buildCardQuote(invoice({ amount_paid: 500 }), 0.04)
    expect(at4.ok && at4.cardTotal).toBe(520)
    const off = buildCardQuote(invoice({ amount_paid: 500 }), 0)
    expect(off.ok && off.cardTotal).toBe(500)
    expect(off.ok && off.fee).toBe(0)
    expect(off.ok && off.rate).toBe(0)
  })

  it('uses the invoice currency (EUR)', () => {
    const q = buildCardQuote(invoice({ amount_currency: 'EUR' }), 0.05)
    expect(q.ok && q.currency).toBe('eur')
  })

  it('refuses an invoice that is already Paid', () => {
    const q = buildCardQuote(invoice({ status: 'Paid', invoice_status: 'Paid' }), 0.05)
    expect(q).toMatchObject({ ok: false, reason: 'paid', error: 'Payment already paid' })
  })

  it('a row Paid on its invoice status only is still refused as paid', () => {
    expect(buildCardQuote(invoice({ status: 'Pending', invoice_status: 'Paid' }), 0.05)).toMatchObject({ ok: false, reason: 'paid' })
  })

  it('refuses a closed invoice (voided / cancelled / credit / split)', () => {
    for (const invoice_status of ['Voided', 'Cancelled', 'Credit', 'Split']) {
      const q = buildCardQuote(invoice({ invoice_status }), 0.05)
      expect(q).toMatchObject({ ok: false, reason: 'closed' })
    }
  })

  it('uses the SAME open/closed rule as the money code: an open invoice_status wins over a Cancelled status', () => {
    // A part-paid invoice that carries status Cancelled but invoice_status Partial is OPEN
    // per isTerminalInvoice — the card button must not disagree with the matcher.
    const q = buildCardQuote(invoice({ status: 'Cancelled', invoice_status: 'Partial', amount_paid: 500 }), 0.05)
    expect(q.ok && q.cardTotal).toBe(525)
  })

  it('refuses when nothing is owed (fully paid but not flagged Paid, or a credit note)', () => {
    expect(buildCardQuote(invoice({ amount_paid: 1000 }), 0.05)).toMatchObject({ ok: false, reason: 'nothing_owed' })
    expect(buildCardQuote(invoice({ amount: -200, total: -200 }), 0.05)).toMatchObject({ ok: false, reason: 'nothing_owed' })
  })

  it('refuses a balance too small for Stripe (under 0.50) and points to bank transfer', () => {
    // EUR 1,000.00 invoice with EUR 999.80 wired leaves 0.20 → card price 0.21
    const q = buildCardQuote(invoice({ amount_currency: 'EUR', amount_paid: 999.8, invoice_status: 'Partial' }), 0.05)
    expect(q).toMatchObject({ ok: false, reason: 'too_small' })
    expect(MIN_CARD_CHARGE).toBe(0.5)
  })

  it('exactly the minimum is allowed', () => {
    const q = buildCardQuote(invoice({ amount: 0.5, total: 0.5 }), 0)
    expect(q.ok && q.cardTotal).toBe(0.5)
  })

  it('refuses an unsupported currency', () => {
    expect(buildCardQuote(invoice({ amount_currency: 'GBP' }), 0.05)).toMatchObject({ ok: false, reason: 'currency' })
  })
})

describe('stripeProductName — the one line the client sees on Stripe\'s page', () => {
  it('ordinary invoice with a fee: says the fee is included, rate from the quote', () => {
    expect(stripeProductName('Annual renewal', { alreadyPaid: 0, fee: 50, rate: 0.05 })).toBe('Annual renewal + 5% card fee')
    expect(stripeProductName('Annual renewal', { alreadyPaid: 0, fee: 40, rate: 0.04 })).toBe('Annual renewal + 4% card fee')
  })
  it('part-paid: says it is only the remaining balance', () => {
    expect(stripeProductName('Annual renewal', { alreadyPaid: 500, fee: 25, rate: 0.05 })).toBe('Annual renewal — remaining balance + 5% card fee')
  })
  it('no fee (switch off): no fee text', () => {
    expect(stripeProductName('Annual renewal', { alreadyPaid: 0, fee: 0, rate: 0 })).toBe('Annual renewal')
    expect(stripeProductName('Annual renewal', { alreadyPaid: 500, fee: 0, rate: 0 })).toBe('Annual renewal — remaining balance')
  })
  it('never cuts an emoji in half (a lone surrogate would break the Stripe call)', () => {
    const name = stripeProductName('😀'.repeat(200), { alreadyPaid: 0, fee: 0, rate: 0 })
    expect(Array.from(name)).toHaveLength(120)
    expect(() => encodeURIComponent(name)).not.toThrow() // throws on a lone surrogate
    // an emoji straddling the cut point
    const straddle = stripeProductName('a'.repeat(119) + '😀😀', { alreadyPaid: 0, fee: 0, rate: 0 })
    expect(() => encodeURIComponent(straddle)).not.toThrow()
  })

  it('falls back to a plain label and never grows without bound', () => {
    expect(stripeProductName(null, { alreadyPaid: 0, fee: 0, rate: 0 })).toBe('Invoice Payment')
    expect(stripeProductName('x'.repeat(500), { alreadyPaid: 0, fee: 0, rate: 0 }).length).toBe(120)
  })
})
