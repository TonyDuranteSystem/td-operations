import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }))
vi.mock('@/components/offers/create-offer-dialog', () => ({ CreateOfferDialog: () => null }))
vi.mock('@/components/offers/welcome-link-button', () => ({ WelcomeLinkButton: () => null }))
vi.mock('@/app/(dashboard)/leads/[id]/components/confirm-payment-dialog', () => ({ ConfirmPaymentDialog: () => null }))
vi.mock('@/components/ui/confirm-destructive-dialog', () => ({ ConfirmDestructiveDialog: () => null }))
vi.mock('@/components/offers/offer-blocked-dialog', () => ({ OfferBlockedDialog: () => null }))
vi.mock('@/components/offers/offer-send-check-box', () => ({ OfferSendCheckBox: () => null }))

import { AccountOfferPanel, type OfferData } from '@/components/offers/account-offer-panel'

const offer = (over: Partial<OfferData> = {}): OfferData => ({
  id: 'o1',
  token: 'tok-onboarding',
  status: 'signed',
  contract_type: 'onboarding',
  cost_summary: null,
  bundled_pipelines: null,
  view_count: 0,
  viewed_at: null,
  created_at: '2026-02-01T10:00:00Z',
  required_documents: null,
  ...over,
})

const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(AccountOfferPanel, {
      accountId: 'a1',
      companyName: 'Sample LLC',
      clientEmail: 'sample@example.com',
      isAdmin: true,
      offers: [offer()],
      ...props,
    } as never),
  )

describe('Offers card on the company page (starts closed)', () => {
  it('starts closed: the count and one line per offer (type and status), and none of the offer details', () => {
    const h = render({ startClosed: true })
    expect(h).toContain('Offers (1)')
    expect(h).toContain('aria-expanded="false"')
    expect(h).toContain('data-testid="offers-summary"')
    expect(h).toContain('Onboarding')
    expect(h).toContain('Signed')
    // the open card's own contents are not drawn
    expect(h).not.toContain('tok-onboarding')
  })

  it('Create New Offer stays visible while the card is closed', () => {
    expect(render({ startClosed: true })).toContain('Create New Offer')
  })

  it('an offer still waiting on the client is visible without opening: its status is in the header', () => {
    const h = render({ startClosed: true, offers: [offer({ id: 'o2', token: 't2', status: 'sent', contract_type: 'formation' })] })
    expect(h).toContain('Formation')
    expect(h).toContain('Sent')
  })

  it('an activated-before-payment offer says so in the closed header', () => {
    const h = render({
      startClosed: true,
      pendingActivations: { 'tok-onboarding': { status: 'activated', activated_at: '2026-03-01', payment_confirmed_at: null } },
    })
    expect(h).toContain('Activated · payment pending')
  })

  it('several offers: one summary item each, newest first', () => {
    const h = render({
      startClosed: true,
      offers: [
        offer({ id: 'old', token: 'a', created_at: '2026-01-01T00:00:00Z', contract_type: 'formation', status: 'completed' }),
        offer({ id: 'new', token: 'b', created_at: '2026-06-01T00:00:00Z', contract_type: 'itin', status: 'sent' }),
      ],
    })
    expect(h.match(/data-testid="offers-summary-item"/g)?.length).toBe(2)
    expect(h.indexOf('ITIN')).toBeLessThan(h.indexOf('Formation'))
  })

  it('no offers: the header says so, and there is no summary list', () => {
    const h = render({ startClosed: true, offers: [] })
    expect(h).toContain('No offer exists for this account')
    expect(h).not.toContain('Offers (')
    expect(h).not.toContain('data-testid="offers-summary"')
  })
})

describe('Offers card elsewhere (the Contact page) is unchanged: open', () => {
  it('without startClosed the card is open and shows the offer itself', () => {
    const h = render({})
    expect(h).toContain('aria-expanded="true"')
    expect(h).toContain('tok-onboarding')
    expect(h).not.toContain('data-testid="offers-summary"')
  })
})
