import { describe, it, expect } from 'vitest'
import { journeyHeaderSummary, type JourneyHeaderInput } from '@/lib/accounts/journey-summary'

const base = (over: Partial<JourneyHeaderInput> = {}): JourneyHeaderInput => ({
  steps: [],
  forms: [],
  portalTier: 'active',
  accountType: 'Client',
  accountStatus: 'Active',
  ...over,
})
const submitted = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Form ${i + 1}`, status: 'submitted' as const }))

describe('journeyHeaderSummary — the closed Account journey line', () => {
  it('an active client with every form in: "Active client · 4 forms submitted"', () => {
    expect(journeyHeaderSummary(base({ forms: submitted(4) }))).toEqual({ tone: 'good', label: 'Active client', detail: '4 forms submitted' })
  })

  it('one form says "1 form submitted"; none says nothing extra', () => {
    expect(journeyHeaderSummary(base({ forms: submitted(1) })).detail).toBe('1 form submitted')
    expect(journeyHeaderSummary(base()).detail).toBe('')
  })

  it('grey Offer/Signed steps (an expired offer) do NOT make an active client look stuck', () => {
    const greySteps = [{ status: 'pending' as const }, { status: 'pending' as const }, { status: 'done' as const }]
    expect(journeyHeaderSummary(base({ steps: greySteps, forms: submitted(2) })).label).toBe('Active client')
  })

  it('a closed or cancelled account just says its status', () => {
    expect(journeyHeaderSummary(base({ accountStatus: 'Closed', forms: submitted(2) }))).toEqual({ tone: 'neutral', label: 'Closed', detail: '2 forms submitted' })
    expect(journeyHeaderSummary(base({ accountStatus: 'Cancelled' })).label).toBe('Cancelled')
  })

  it('a suspended or offboarding account is not called "Active client" even if its tier is still active', () => {
    expect(journeyHeaderSummary(base({ accountStatus: 'Suspended' })).label).toBe('Suspended')
    expect(journeyHeaderSummary(base({ accountStatus: 'Offboarding' })).label).toBe('Offboarding')
  })

  describe('waiting for payment', () => {
    it('shows the days since signing, in amber', () => {
      const r = journeyHeaderSummary(base({ steps: [{ status: 'issue', flag: 'awaiting_payment', days: 9 }], forms: submitted(1) }))
      expect(r).toEqual({ tone: 'warn', label: 'Waiting for payment', detail: '9 days since signing' })
    })
    it('"1 day" is singular', () => {
      const r = journeyHeaderSummary(base({ steps: [{ status: 'current', flag: 'awaiting_payment', days: 1 }] }))
      expect(r.detail).toBe('1 day since signing')
    })
    it('beats a form in progress', () => {
      const r = journeyHeaderSummary(base({
        steps: [{ status: 'issue', flag: 'awaiting_payment', days: 12 }],
        forms: [{ label: 'Banking (Relay USD)', status: 'in_progress' }],
      }))
      expect(r.label).toBe('Waiting for payment')
    })
    it('a step already done is ignored', () => {
      const r = journeyHeaderSummary(base({ steps: [{ status: 'done', flag: 'awaiting_payment', days: 3 }] }))
      expect(r.label).toBe('Active client')
    })
  })

  describe('onboarding not started', () => {
    const steps = (status: 'issue' | 'current', days: number) => [{ status, flag: 'onboarding_not_started' as const, days }]
    it('over 3 days is amber, with the days since payment', () => {
      expect(journeyHeaderSummary(base({ portalTier: 'onboarding', steps: steps('issue', 5) }))).toEqual({
        tone: 'warn',
        label: 'Onboarding not started',
        detail: '5 days since payment',
      })
    })
    it('a fresh one is blue', () => {
      expect(journeyHeaderSummary(base({ portalTier: 'onboarding', steps: steps('current', 2) })).tone).toBe('info')
    })
    it('is NOT shown for an active-tier client (no form records on an old client is not "not started")', () => {
      expect(journeyHeaderSummary(base({ portalTier: 'active', steps: steps('issue', 200) })).label).toBe('Active client')
    })
  })

  describe('forms', () => {
    it('a form in progress is blue and names the form, with the submitted count', () => {
      const r = journeyHeaderSummary(base({ forms: [...submitted(3), { label: 'Banking (Relay USD)', status: 'in_progress' }] }))
      expect(r).toEqual({ tone: 'info', label: 'Form in progress', detail: 'Banking (Relay USD) · 3 forms submitted' })
    })
    it('a form the client has not started is amber', () => {
      const r = journeyHeaderSummary(base({ forms: [{ label: 'Tax Return', status: 'pending' }] }))
      expect(r).toEqual({ tone: 'warn', label: 'Form not started', detail: 'Tax Return' })
    })
    it('not started outranks in progress', () => {
      const r = journeyHeaderSummary(base({ forms: [{ label: 'A', status: 'in_progress' }, { label: 'B', status: 'pending' }] }))
      expect(r.label).toBe('Form not started')
    })
    it('several are counted and the names are cut to two', () => {
      const forms = ['A', 'B', 'C', 'D'].map((label) => ({ label, status: 'in_progress' as const }))
      expect(journeyHeaderSummary(base({ forms }))).toEqual({ tone: 'info', label: '4 forms in progress', detail: 'A, B +2 more' })
    })
  })

  describe('stage and fallback', () => {
    it('formation and onboarding tiers say so', () => {
      expect(journeyHeaderSummary(base({ portalTier: 'formation', accountStatus: 'Pending Formation' })).label).toBe('Formation in progress')
      expect(journeyHeaderSummary(base({ portalTier: 'onboarding' })).label).toBe('Onboarding in progress')
    })
    it('anything else says the account status, or "Not active yet"', () => {
      expect(journeyHeaderSummary(base({ portalTier: 'lead', accountStatus: 'Pending Formation' }))).toEqual({ tone: 'neutral', label: 'Pending Formation', detail: '' })
      expect(journeyHeaderSummary(base({ portalTier: null, accountStatus: null, accountType: null })).label).toBe('Not active yet')
    })
    it('a missing status still counts as active when the tier is active and the account is a client', () => {
      expect(journeyHeaderSummary(base({ accountStatus: null })).label).toBe('Active client')
    })
  })
})
