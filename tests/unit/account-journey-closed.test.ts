import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccountJourney, deriveAccountJourneySteps, buildWizardEntries, type AccountJourneyProps } from '@/components/accounts/account-journey'

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

const wiz = (wizard_type: string, status: string, updated_at = '2026-08-17T10:00:00Z') => ({
  wizard_type, status, current_step: 1, updated_at, data: status === 'submitted' ? { q: 'a' } : null,
})

const props = (over: Partial<AccountJourneyProps> = {}): AccountJourneyProps => ({
  offer: { token: 't1', status: 'completed', contract_type: 'onboarding', created_at: '2026-04-12T00:00:00Z', view_count: 7 },
  pendingActivation: { signed_at: '2026-04-14T00:00:00Z', payment_confirmed_at: '2026-04-16T00:00:00Z', payment_method: 'Bank transfer', activated_at: '2026-04-18T00:00:00Z', status: 'activated' },
  wizardProgress: { status: 'submitted', current_step: 1, wizard_type: 'banking_relay', updated_at: '2026-09-07T00:00:00Z' },
  allWizards: [wiz('banking_relay', 'submitted'), wiz('tax', 'submitted'), wiz('itin', 'submitted')],
  serviceDeliveries: [{ status: 'completed', stage: 'Complete', pipeline: null, service_name: 'Onboarding' }],
  accountType: 'Client',
  portalTier: 'active',
  accountStatus: 'Active',
  hasPaidPayment: true,
  ...over,
})

const render = (p: AccountJourneyProps) => renderToStaticMarkup(createElement(AccountJourney, p))

describe('Account journey card: starts closed with one line', () => {
  it('closed: the line says where the client is, and none of the steps or form rows are drawn', () => {
    const h = render(props())
    expect(h).toContain('aria-expanded="false"')
    expect(h).toContain('data-testid="account-journey-summary"')
    expect(h).toContain('Active client')
    expect(h).toContain('3 forms submitted')
    expect(h).not.toContain('data-testid="account-journey-body"')
    expect(h).not.toContain('data-testid="wizard-row"')
    expect(h).not.toContain('Client Wizard Submissions')
  })

  it('open: the six steps and one slim row per form are there, and the summary line is gone', () => {
    const h = render(props({ startOpen: true }))
    expect(h).toContain('aria-expanded="true"')
    expect(h).toContain('data-testid="account-journey-body"')
    for (const label of ['Offer', 'Signed', 'Paid', 'Onboarding', 'Services', 'Active']) expect(h).toContain(`>${label}<`)
    expect(h.match(/data-testid="wizard-row"/g)?.length).toBe(3)
    expect(h).toContain('Export')
    expect(h).not.toContain('data-testid="account-journey-summary"')
  })

  it('does not draw the Partner Bank Applications panel any more (it is its own card now)', () => {
    expect(render(props({ startOpen: true }))).not.toContain('Partner Bank Applications')
  })

  it('a client whose newest offer is old and unsigned still reads "Active client" (the odd steps stay inside the card)', () => {
    const p = props({
      offer: { token: 't2', status: 'viewed', contract_type: 'formation', created_at: '2026-09-02T00:00:00Z', view_count: 3 },
      pendingActivation: null,
    })
    const closed = render(p)
    expect(closed).toContain('Active client')
    expect(closed).not.toContain('Waiting for payment')
    expect(render({ ...p, startOpen: true })).toContain('Awaiting signature')
  })

  it('signed 9 days ago and not paid: the header says so in words', () => {
    const p = props({
      offer: { token: 't3', status: 'signed', contract_type: 'formation', created_at: daysAgo(12) },
      pendingActivation: { signed_at: daysAgo(9), payment_confirmed_at: null, payment_method: null, activated_at: null, status: 'awaiting_payment' },
      wizardProgress: null,
      allWizards: [],
      serviceDeliveries: [],
      portalTier: 'formation',
      accountStatus: 'Pending Formation',
      hasPaidPayment: false,
    })
    const h = render(p)
    expect(h).toContain('Waiting for payment')
    expect(h).toContain('9 days since signing')
  })

  it('a form in progress shows in the header with its name', () => {
    const h = render(props({ allWizards: [wiz('banking_relay', 'in_progress'), wiz('tax', 'submitted')] }))
    expect(h).toContain('Form in progress')
    expect(h).toContain('Banking (Relay USD)')
    expect(h).toContain('1 form submitted')
  })

  it('draws nothing for an account with no offer, no services and not active (unchanged)', () => {
    expect(render(props({ offer: null, serviceDeliveries: [], accountStatus: 'Pending Formation', allWizards: [] }))).toBe('')
  })
})

describe('step flags: only real dates can make a client look stuck', () => {
  it('an old client with no wizard record and no payment date gets NO onboarding flag', () => {
    const steps = deriveAccountJourneySteps(props({ wizardProgress: null, allWizards: [], pendingActivation: null }))
    expect(steps.find((s) => s.label === 'Onboarding')?.flag).toBeUndefined()
  })
  it('paid 5 days ago with no wizard record flags onboarding with the days', () => {
    const steps = deriveAccountJourneySteps(props({
      wizardProgress: null, allWizards: [],
      pendingActivation: { signed_at: daysAgo(8), payment_confirmed_at: daysAgo(5), payment_method: 'Card', activated_at: null, status: 'payment_confirmed' },
    }))
    const o = steps.find((s) => s.label === 'Onboarding')
    expect(o?.flag).toBe('onboarding_not_started')
    expect(o?.days).toBe(5)
  })
})

describe('buildWizardEntries', () => {
  it('submitted first, then in progress, then forms an active service still expects', () => {
    const e = buildWizardEntries(
      [wiz('tax', 'in_progress'), wiz('itin', 'submitted')],
      [{ status: 'active', stage: null, pipeline: null, service_name: 'Banking Fintech' }],
    )
    expect(e.map((x) => `${x.wizard_type}:${x.status}`)).toEqual(['itin:submitted', 'tax:in_progress', 'banking_payset:pending', 'banking_relay:pending'])
  })
})
