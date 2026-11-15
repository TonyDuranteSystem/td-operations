import { describe, it, expect } from 'vitest'
import { activationFlags, offerStatusLabel, offerSummaryItems, offerTypeLabel } from '@/lib/offers/offer-summary'

const offer = (over: Partial<{ id: string; token: string; status: string; contract_type: string | null; created_at: string }> = {}) => ({
  id: 'o1',
  token: 'tok-1',
  status: 'signed',
  contract_type: 'onboarding',
  created_at: '2026-02-01T10:00:00Z',
  ...over,
})

describe('offerTypeLabel', () => {
  it('names the usual types the way the Signed contracts card does', () => {
    expect(offerTypeLabel('formation')).toBe('Formation')
    expect(offerTypeLabel('onboarding')).toBe('Onboarding')
    expect(offerTypeLabel('renewal')).toBe('Annual renewal')
    expect(offerTypeLabel('itin')).toBe('ITIN')
    expect(offerTypeLabel('company_change_name')).toBe('Company name change')
  })
  it('an offer with no type is just "Offer"', () => {
    expect(offerTypeLabel(null)).toBe('Offer')
    expect(offerTypeLabel('')).toBe('Offer')
    expect(offerTypeLabel('   ')).toBe('Offer')
  })
  it('an unknown type is shown readably, never blank', () => {
    expect(offerTypeLabel('custom_boat_license')).toBe('Boat license')
  })
})

describe('offerStatusLabel', () => {
  it('capitalises the first letter only', () => {
    expect(offerStatusLabel('signed')).toBe('Signed')
    expect(offerStatusLabel('completed')).toBe('Completed')
  })
  it('a missing status is "Unknown", never blank', () => {
    expect(offerStatusLabel(null)).toBe('Unknown')
    expect(offerStatusLabel('')).toBe('Unknown')
  })
})

describe('activationFlags — the same facts the open offer card uses', () => {
  it('nothing recorded: not activated, not paid', () => {
    expect(activationFlags(null)).toEqual({ isActivated: false, isPaid: false })
    expect(activationFlags(undefined)).toEqual({ isActivated: false, isPaid: false })
  })
  it('activated by the date or by the status', () => {
    expect(activationFlags({ status: null, activated_at: '2026-03-01', payment_confirmed_at: null }).isActivated).toBe(true)
    expect(activationFlags({ status: 'activated', activated_at: null, payment_confirmed_at: null }).isActivated).toBe(true)
  })
  it('paid only when a payment was confirmed', () => {
    expect(activationFlags({ status: 'activated', activated_at: '2026-03-01', payment_confirmed_at: '2026-03-02' }).isPaid).toBe(true)
    expect(activationFlags({ status: 'activated', activated_at: '2026-03-01', payment_confirmed_at: null }).isPaid).toBe(false)
  })
})

describe('offerSummaryItems — the one line per offer on the closed card', () => {
  it('an offer that is still unsigned shows its status, so it is never hidden', () => {
    const items = offerSummaryItems([offer({ status: 'sent', contract_type: 'formation' })])
    expect(items).toEqual([{ id: 'o1', type: 'Formation', status: 'Sent', statusKey: 'sent', activation: 'none' }])
  })

  it('newest first, same order as the open card', () => {
    const items = offerSummaryItems([
      offer({ id: 'old', created_at: '2026-01-01T00:00:00Z' }),
      offer({ id: 'new', token: 'tok-2', created_at: '2026-06-01T00:00:00Z' }),
    ])
    expect(items.map((i) => i.id)).toEqual(['new', 'old'])
  })

  it('activated and paid, and activated before payment, are told apart', () => {
    const items = offerSummaryItems(
      [offer({ id: 'a', token: 'ta' }), offer({ id: 'b', token: 'tb' }), offer({ id: 'c', token: 'tc' })],
      {
        ta: { status: 'activated', activated_at: '2026-03-01', payment_confirmed_at: '2026-03-02' },
        tb: { status: 'activated', activated_at: '2026-03-01', payment_confirmed_at: null },
        tc: null,
      },
    )
    const by = Object.fromEntries(items.map((i) => [i.id, i.activation]))
    expect(by).toEqual({ a: 'activated', b: 'activated_unpaid', c: 'none' })
  })

  it('each offer looks up its OWN activation, never another offer\'s', () => {
    const items = offerSummaryItems([offer({ id: 'x', token: 'tx' }), offer({ id: 'y', token: 'ty' })], {
      tx: { status: 'activated', activated_at: '2026-03-01', payment_confirmed_at: '2026-03-02' },
    })
    expect(items.find((i) => i.id === 'y')?.activation).toBe('none')
  })

  it('no offers: nothing to summarise', () => {
    expect(offerSummaryItems([])).toEqual([])
  })

  it('does not reorder the list it was given', () => {
    const list = [offer({ id: 'old', created_at: '2026-01-01T00:00:00Z' }), offer({ id: 'new', token: 't2', created_at: '2026-06-01T00:00:00Z' })]
    offerSummaryItems(list)
    expect(list.map((o) => o.id)).toEqual(['old', 'new'])
  })
})
