import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import StandaloneServiceAgreement from '@/app/offer/[token]/contract/standalone-service-agreement'
import { STANDALONE_AGREEMENT_TYPES } from '@/lib/offers/standalone-contract-types'

/**
 * A single-service short contract must read exactly as it always has. The stored
 * copies in tests/unit/__golden__ were taken from the page BEFORE the
 * "several agreements, signed once" change; any difference for a one-service offer
 * is a regression of a legal document. Regenerate deliberately with UPDATE_GOLDEN=1.
 */
const GOLDEN_DIR = join(process.cwd(), 'tests/unit/__golden__')
const cred = { token: 't', code: 'c', pass: '', preview: false }

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-25T12:00:00Z')) })
afterAll(() => { vi.useRealTimers() })

function offerFor(type: string, extra: Record<string, unknown> = {}) {
  return {
    token: 'golden-token', client_name: 'Golden Client', client_email: 'golden@example.com', language: 'en',
    contract_type: type, status: 'sent', bank_details: null, payment_links: null, cost_summary: [], selected_services: [],
    services: [{ name: 'Golden Service', price: '$100', contract_type: type, description: 'A golden description', includes: ['One thing', 'Another thing'] }],
    ...extra,
  }
}
const html = (type: string, extra?: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(StandaloneServiceAgreement, { offer: offerFor(type, extra) as never, token: 'golden-token', contractType: type as never, cred }))

describe('single-service short contracts are unchanged', () => {
  for (const t of STANDALONE_AGREEMENT_TYPES) {
    it(`${t}`, () => {
      const file = join(GOLDEN_DIR, `standalone-${t}.html`)
      const out = html(t)
      if (process.env.UPDATE_GOLDEN === '1') writeFileSync(file, out)
      expect(existsSync(file), `${file} is missing — it is the saved copy of today's contract`).toBe(true)
      expect(out).toBe(readFileSync(file, 'utf8'))
    })
  }

  it('itin with a quantity keeps its own closing text', () => {
    const file = join(GOLDEN_DIR, 'standalone-itin-qty3.html')
    const out = html('itin', { services: [{ name: 'ITIN Application', price: '$1,200', contract_type: 'itin', quantity: 3 }] })
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(file, out)
    expect(existsSync(file), `${file} is missing — it is the saved copy of today's contract`).toBe(true)
    expect(out).toBe(readFileSync(file, 'utf8'))
  })
})

describe('several short agreements in one document, signed once', () => {
  const TAX = { name: 'Tax Return 2025', price: '$500', contract_type: 'tax_return' }
  const CALL = { name: 'Consulting Call', price: '$100', contract_type: 'consulting_call' }
  const SHIP = { name: 'Shipping Service', price: '$80', contract_type: 'shipping', description: 'Ship it' }
  const bundle = (extra: Record<string, unknown> = {}) => html('tax_return', { multi_agreements: true, services: [TAX, CALL, SHIP], ...extra })
  const count = (h: string, re: RegExp) => (h.match(re) || []).length

  it('shows every agreement with its own title, service and fee', () => {
    const h = bundle()
    expect(h).toContain('Service Agreements')
    expect(h).toContain('This document contains <strong>3 agreements</strong>, for the following services in your offer')
    for (const title of ['Tax Return Filing Agreement', 'Consulting Call Service Agreement', 'Shipping Service Agreement']) expect(h).toContain(title)
    expect(h).toContain('$500')
    expect(h).toContain('$100')
    expect(h).toContain('$80')
    expect(h).toContain('Ship it')
    expect(count(h, /data-agreement="/g)).toBe(3)
  })

  it('takes ONE signature: a single signature box and one sign button', () => {
    const h = bundle()
    expect(count(h, /<canvas/g)).toBe(1)
    expect(count(h, /Sign &amp; Accept All Agreements/g)).toBe(1)
  })

  it('the signature text names every agreement and keeps each one\'s own acknowledgments', () => {
    const h = bundle()
    expect(h).toContain('By signing once below, I accept each of the 3 agreements in this document')
    expect(h).toContain('read and agree to the terms of this Consulting Call Service Agreement')
    expect(h).toContain('read and agree to the terms of this Tax Return Filing Agreement')
    expect(h).toContain('I authorize Tony Durante LLC to ship my documents')
  })

  it('an agreement uses its own wording for the work and the liability', () => {
    expect(bundle()).toContain('the consulting service')
  })

  it('two lines of the same type are two agreements (both are billed), each with its own fee', () => {
    const h = html('tax_return', { multi_agreements: true, services: [{ ...TAX, name: 'Tax Return 2024', price: '$450' }, { ...TAX, name: 'Tax Return 2025', price: '$500' }] })
    expect(count(h, /data-agreement="tax_return"/g)).toBe(2)
    expect(h).toContain('$450')
    expect(h).toContain('$500')
    // the acceptance sentence is not repeated for the same agreement type
    expect(count(h, /<strong>Tax Return Filing Agreement\.<\/strong>/g)).toBe(1)
    expect(h).toContain('accept each of the 2 agreements')
  })

  it('an unticked optional service is not in the document — including the offer\'s main type', () => {
    const h = html('tax_return', {
      multi_agreements: true,
      services: [{ ...TAX, optional: true }, CALL, SHIP],
      selected_services: ['Consulting Call', 'Shipping Service'],
    })
    expect(h).not.toContain('Tax Return Filing Agreement')
    expect(h).toContain('accept each of the 2 agreements')
    expect(h).toContain('Consulting Call Service Agreement')
  })

  it('only one ticked short service left: the page is the plain single agreement, no lead-in', () => {
    const h = html('consulting_call', { multi_agreements: true, services: [CALL, { ...SHIP, optional: true }], selected_services: ['Consulting Call'] })
    expect(h).not.toContain('data-agreements-intro')
    expect(h).not.toContain('By signing once below')
    expect(h).toContain('Sign &amp; Accept Agreement')
  })

  it('a one-service offer shows no lead-in and its own single acceptance text', () => {
    const h = html('consulting_call')
    expect(h).not.toContain('data-agreements-intro')
    expect(h).not.toContain('By signing once below')
  })
})

describe('the switch is OFF: the page is exactly what it always was', () => {
  const services = [
    { name: 'Tax Return 2025', price: '$500', contract_type: 'tax_return' },
    { name: 'Consulting Call', price: '$100', contract_type: 'consulting_call' },
  ]
  it('a two-service offer with no flag shows only the first agreement', () => {
    const h = html('tax_return', { services })
    expect(h).toContain('Tax Return Filing Agreement')
    expect(h).not.toContain('Consulting Call Service Agreement')
    expect(h).not.toContain('data-agreements-intro')
    expect(h).not.toContain('By signing once below')
    expect(h).toContain('Sign &amp; Accept Agreement')
  })
  it('an explicit false is the same as no flag, and equals the single-service page for the same first service', () => {
    const off = html('tax_return', { multi_agreements: false, services })
    const single = html('tax_return', { services: [services[0]] })
    expect(off).toBe(single)
  })
  it('switched OFF, a declined main-type service is still shown (the original behaviour)', () => {
    const h = html('tax_return', {
      services: [{ name: 'Tax Return 2025', price: '$500', contract_type: 'tax_return', optional: true }, { name: 'ITIN Application', price: '$300', contract_type: 'itin' }],
      selected_services: ['ITIN Application'],
    })
    expect(h).toContain('Tax Return Filing Agreement')
  })
})

describe('switch ON: the client declined the offer\'s own service', () => {
  it('only the service they are buying is shown, with its own agreement and acceptance', () => {
    const h = html('tax_return', {
      multi_agreements: true,
      services: [{ name: 'Tax Return 2025', price: '$500', contract_type: 'tax_return', optional: true }, { name: 'ITIN Application', price: '$300', contract_type: 'itin' }],
      selected_services: ['ITIN Application'],
    })
    expect(h).toContain('ITIN Application Service Agreement')
    expect(h).not.toContain('Tax Return Filing Agreement')
    expect(h).not.toContain('data-agreements-intro')
    expect(h).toContain('$300')
  })
})

describe('a service that is included / free', () => {
  const free = (price: string, type = 'shipping') => html(type, { services: [{ name: 'Svc', price, contract_type: type }] })
  it('says it is included instead of "$0 payable in full, non-refundable"', () => {
    for (const price of ['$0', '€0.00', 'Included', 'Free']) {
      const h = free(price)
      expect(h, price).toContain('Included \u2014 no separate charge')
      expect(h, price).toContain('No service fee is payable to the Service Provider for this service itself')
      expect(h, price).not.toContain('non-refundable')
      expect(h, price).not.toContain('payable in full')
    }
  })
  it('does not contradict the agreement\'s own third-party charges (e.g. Shipping: the client pays customs duties)', () => {
    const h = free('$0', 'shipping')
    expect(h).toContain('Pay any customs duties, import taxes or local fees')
    expect(h).toContain('Any third-party or government charges described in this Agreement remain the Client')
    expect(h).not.toContain('No payment is due')
  })
  it('a paid service is unchanged', () => {
    const h = free('$80')
    expect(h).toContain('$80')
    expect(h).toContain('payable in full')
    expect(h).toContain('non-refundable')
  })
})

describe('Closure and ITIN use their own wording (not the tax-return wording)', () => {
  it('closure', () => {
    const h = html('closure')
    expect(h).toContain('payable in full before the company closure begins')
    expect(h).toContain('once the company closure has commenced')
    expect(h).toContain('not liable for the timing or outcome of any state or IRS processing of the closure')
    expect(h).not.toContain('tax return preparation')
    expect(h).not.toContain('additional taxes')
  })
  it('itin', () => {
    const h = html('itin')
    expect(h).toContain('payable in full before the ITIN application begins')
    expect(h).toContain('once the ITIN application has commenced')
    expect(h).toContain('processing time, or for consequences')
    expect(h).not.toContain('tax return preparation')
    expect(h).not.toContain('additional taxes')
  })
  it('tax return keeps the tax-return wording', () => {
    const h = html('tax_return')
    expect(h).toContain('payable in full before the tax return preparation begins')
    expect(h).toContain('penalties, interest, or additional taxes')
  })
})

describe('switch ON, MCP-style offer: the offer\'s own line has no type of its own', () => {
  it('each service gets ITS OWN agreement (the add-on is not shown with the main service\'s wording)', () => {
    for (const services of [
      [{ name: 'Tax Return 2025', price: '$500' }, { name: 'Consulting Call', price: '$100', contract_type: 'consulting_call' }],
      [{ name: 'Consulting Call', price: '$100', contract_type: 'consulting_call' }, { name: 'Tax Return 2025', price: '$500' }],
    ]) {
      const h = html('tax_return', { multi_agreements: true, services })
      expect(h).toContain('This document contains <strong>2 agreements</strong>')
      expect(h).toContain('Tax Return Filing Agreement')
      expect(h).toContain('Consulting Call Service Agreement')
      expect(h).toContain('$500')
      expect(h).toContain('$100')
    }
  })
})
