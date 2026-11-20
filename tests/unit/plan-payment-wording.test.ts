/**
 * Service agreements state the client's payment plan (dev job 0f4941a2, found by the 19 Nov 2026 production QA).
 * Wording approved by Antonio on 19 Nov 2026 ("OK wording, no new version").
 */
import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { planPaymentWordingFor, feeIsWholeOffer } from '@/lib/contracts/plan-payment-wording'
import { PaymentSentence } from '@/components/contracts/payment-sentence'
import { AgreementBody } from '@/components/contracts/agreement-body'
import { SERVICE_CONTENT } from '@/app/offer/[token]/contract/standalone-service-agreement'

const signing = { seq: 1, amount: 250, currency: 'EUR', trigger: { kind: 'signing' } }
const later = { seq: 2, amount: 250, currency: 'EUR', trigger: { kind: 'date', date: '2026-11-27' } }

const offer = (over: Record<string, unknown> = {}) => ({
  services: [{ name: 'Tax Return 2025', price: '€500', contract_type: 'tax_return' }],
  cost_summary: [{ label: 'Setup Fee', total: '€500', items: [{ name: 'Tax Return 2025', price: '€500' }] }],
  currency: 'EUR',
  payment_plan: [signing, later],
  ...over,
})

describe('planPaymentWordingFor — when the agreement states a plan', () => {
  it('a valid two-part plan that matches its offer: the schedule in the sanctioned words', () => {
    const w = planPaymentWordingFor(offer())
    expect(w).not.toBeNull()
    expect(w!.lines).toBe('€250 — Part 1 of 2, due on signing; €250 — Part 2 of 2, due by 27 November 2026')
    expect(w!.total).toBe('€500')
    expect(w!.totalAmount).toBe(500)
    expect(w!.signingSeq).toBe(1)
  })

  it('no plan, a one-part plan or an invalid plan: nothing to say (the ordinary sentence stays)', () => {
    expect(planPaymentWordingFor(offer({ payment_plan: null }))).toBeNull()
    expect(planPaymentWordingFor(offer({ payment_plan: undefined }))).toBeNull()
    expect(planPaymentWordingFor(offer({ payment_plan: [{ ...signing, amount: 500 }] }))).toBeNull()
    expect(planPaymentWordingFor(offer({ payment_plan: 'garbage' }))).toBeNull()
    expect(planPaymentWordingFor(null)).toBeNull()
    expect(planPaymentWordingFor(undefined)).toBeNull()
  })

  it('a plan that disagrees with its offer states nothing: signing bills the whole fee, so "payable in full" is true', () => {
    // parts add up to 600, the offer is 500
    expect(planPaymentWordingFor(offer({ payment_plan: [{ ...signing, amount: 300 }, { ...later, amount: 300 }] }))).toBeNull()
    // plan in USD, offer in EUR
    expect(planPaymentWordingFor(offer({ payment_plan: [{ ...signing, currency: 'USD' }, { ...later, currency: 'USD' }] }))).toBeNull()
  })

  it('a plan with no part due at signing says nothing about work starting at Part 1', () => {
    const w = planPaymentWordingFor(offer({ payment_plan: [{ ...signing, trigger: { kind: 'manual', label: 'when your bank account is opened' } }, later] }))
    expect(w).not.toBeNull()
    expect(w!.signingSeq).toBeNull()
    expect(w!.lines).toContain('when your bank account is opened')
  })

  it('a USD offer prints dollars', () => {
    const usd = offer({
      services: [{ name: 'Tax Return 2025', price: '$500', contract_type: 'tax_return' }],
      cost_summary: [{ label: 'Setup Fee', total: '$500', items: [{ name: 'Tax Return 2025', price: '$500' }] }],
      currency: 'USD',
      payment_plan: [{ ...signing, currency: 'USD' }, { ...later, currency: 'USD' }],
    })
    const w = planPaymentWordingFor(usd)
    expect(w!.total).toBe('$500')
    expect(w!.lines.startsWith('$250 — Part 1 of 2, due on signing')).toBe(true)
  })

  it('names the part that is actually due at signing, even when it is not Part 1', () => {
    const w = planPaymentWordingFor(offer({ payment_plan: [{ ...later, seq: 1, amount: 250 }, { ...signing, seq: 2, amount: 250 }] }))
    expect(w).not.toBeNull()
    expect(w!.signingSeq).toBe(2)
  })

  it('reads the currency the way signing bills it: the offer column, else the cost-summary header', () => {
    // no currency column, a dollar header and a dollar plan: billing sees USD, so the plan is usable and printed in dollars
    const w = planPaymentWordingFor(offer({
      currency: null,
      services: [{ name: 'Tax Return 2025', price: '$500', contract_type: 'tax_return' }],
      cost_summary: [{ label: 'Setup Fee', total: '$500', items: [{ name: 'Tax Return 2025', price: '$500' }] }],
      payment_plan: [{ ...signing, currency: 'USD' }, { ...later, currency: 'USD' }],
    }))
    expect(w).not.toBeNull()
    expect(w!.total).toBe('$500')
  })

  it('never uses the renewal vocabulary — "instalment" / "installment" belongs to the annual contract', () => {
    const w = planPaymentWordingFor(offer())!
    expect(`${w.lines} ${w.total}`).not.toMatch(/instal+ment|rata/i)
  })
})

describe('feeIsWholeOffer — the agreement fee against the plan total', () => {
  const w = planPaymentWordingFor(offer())!
  it('is the whole offer when the line fee equals the plan total', () => {
    expect(feeIsWholeOffer('€500', w)).toBe(true)
    expect(feeIsWholeOffer('€500.00', w)).toBe(true)
  })
  it('is one line of several when it does not', () => {
    expect(feeIsWholeOffer('€300', w)).toBe(false)
    expect(feeIsWholeOffer('', w)).toBe(false)
    expect(feeIsWholeOffer('Included', w)).toBe(false)
    expect(feeIsWholeOffer(null, w)).toBe(false)
  })
})

describe('PaymentSentence — the exact words Antonio approved', () => {
  const legacy = 'The total fee for this service is <strong>€500</strong>, payable in full before services begin. Payment may be made via credit/debit card or bank wire transfer as indicated in the offer.'
  const html = (fee: string, o: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(PaymentSentence, {
      fee,
      plan: planPaymentWordingFor(offer(o)),
      legacy: createElement('span', { dangerouslySetInnerHTML: { __html: legacy } }),
    }))
  const text = (h: string) => h.replace(/<[^>]+>/g, '')

  it('the fee is the whole offer: "The total fee … paid as a Partial Payment schedule"', () => {
    expect(text(html('€500'))).toBe(
      'The total fee for this service is €500, paid as a Partial Payment schedule: €250 — Part 1 of 2, due on signing; €250 — Part 2 of 2, due by 27 November 2026. Work on this service begins once Part 1 is paid. Payment may be made via credit/debit card or bank wire transfer as indicated in the offer.',
    )
  })

  it('the fee is one service of several: ties the line fee to the offer total, never prints a part under a fee it does not belong to', () => {
    const t = text(html('€300'))
    expect(t).toBe(
      'The fee for this service is €300. It is part of one offer totalling €500, which is paid as a Partial Payment schedule: €250 — Part 1 of 2, due on signing; €250 — Part 2 of 2, due by 27 November 2026. Work on this service begins once Part 1 is paid. Payment may be made via credit/debit card or bank wire transfer as indicated in the offer.',
    )
    expect(t).not.toContain('payable in full')
  })

  it('no usable plan: renders the ordinary sentence exactly as it always did', () => {
    const h = renderToStaticMarkup(createElement(PaymentSentence, { fee: '€500', plan: null, legacy: createElement('span', { dangerouslySetInnerHTML: { __html: legacy } }) }))
    expect(h).toBe(`<p><span>${legacy}</span></p>`)
    expect(h).toContain('payable in full before services begin')
  })

  it('a signing part that is Part 2 says "Part 2", not "Part 1"', () => {
    const t = text(html('€500', { payment_plan: [{ ...later, seq: 1 }, { ...signing, seq: 2 }] }))
    expect(t).toContain('Work on this service begins once Part 2 is paid.')
    expect(t).not.toContain('once Part 1 is paid')
  })

  it('a recurring fee is never part of the setup-fee plan: it keeps the ordinary sentence', () => {
    const h = renderToStaticMarkup(createElement(PaymentSentence, {
      fee: '€500/year',
      plan: planPaymentWordingFor(offer()),
      legacy: createElement('span', { dangerouslySetInnerHTML: { __html: legacy } }),
    }))
    expect(h).toBe(`<p><span>${legacy}</span></p>`)
  })

  it('a plan with no part at signing omits the "begins once Part 1 is paid" sentence', () => {
    const t = text(html('€500', { payment_plan: [{ ...signing, trigger: { kind: 'manual', label: 'when your bank account is opened' } }, later] }))
    expect(t).not.toContain('begins once Part 1 is paid')
    expect(t).toContain('paid as a Partial Payment schedule')
  })
})

describe('AgreementBody section 5 — plan or no plan', () => {
  const ct = SERVICE_CONTENT.tax_return
  const base = {
    ct, clientName: 'Uxio Test', serviceName: 'Tax Return 2025', serviceDesc: '', includes: [] as string[],
    scopeClosing: ct.scope.closing, workPhrase: 'the preparation', liabilityPhrase: 'delays',
  }
  const render = (fee: string, plan: ReturnType<typeof planPaymentWordingFor>) =>
    renderToStaticMarkup(createElement(AgreementBody, { ...base, fee, plan }))

  it('without a plan the page is byte-for-byte the legacy page (no plan prop at all)', () => {
    const without = renderToStaticMarkup(createElement(AgreementBody, { ...base, fee: '€500' }))
    expect(without).toBe(render('€500', null))
    expect(without).toContain('payable in full before the preparation begins')
    // the exact paragraph the page printed before this change
    expect(without).toContain('<p>The total fee for this service is <strong>€500</strong>, payable in full before the preparation begins. Payment may be made via credit/debit card or bank wire transfer as indicated in the offer.</p>')
  })

  it('with a plan it states the schedule and keeps the non-refundable line', () => {
    const h = render('€500', planPaymentWordingFor(offer()))
    expect(h).toContain('paid as a Partial Payment schedule')
    expect(h).not.toContain('payable in full')
    expect(h).toContain('All fees are non-refundable')
  })

  it('a free / included service is untouched even when the offer has a plan', () => {
    const h = render('Included', planPaymentWordingFor(offer()))
    expect(h).toContain('No service fee is payable to the Service Provider')
    expect(h).not.toContain('Partial Payment')
  })
})
