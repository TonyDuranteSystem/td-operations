import { describe, it, expect } from 'vitest'
import { buildStageAdvanceCopy } from '@/lib/portal/notifications'

describe('buildStageAdvanceCopy', () => {
  it('builds the generic EN copy when no custom message', () => {
    const c = buildStageAdvanceCopy({ locale: 'en', serviceName: 'Tax Return', stageName: 'Wizard Available', firstName: 'Matteo' })
    expect(c.greeting).toBe('Hi Matteo,')
    expect(c.subject).toBe('Service update: Tax Return — Wizard Available')
    expect(c.headline).toBe('Your service "Tax Return" has moved to the "Wizard Available" stage.')
    expect(c.bodyText).toBe('Log in to the client portal to see the latest details.')
    expect(c.ctaLabel).toBe('Open the Portal')
  })

  it('builds the generic IT copy when no custom message', () => {
    const c = buildStageAdvanceCopy({ locale: 'it', serviceName: 'Tax Return', stageName: 'Wizard Available', firstName: 'Matteo' })
    expect(c.greeting).toBe('Ciao Matteo,')
    expect(c.headline).toContain('è passato alla fase')
    expect(c.ctaLabel).toBe('Apri il Portale')
  })

  it('uses the custom message as the headline and drops the secondary line', () => {
    const msg = 'Your tax return wizard is now available. Please log in to the client portal and submit your tax information.'
    const c = buildStageAdvanceCopy({ locale: 'en', serviceName: 'Tax Return', stageName: 'Wizard Available', firstName: 'Matteo', customMessage: msg })
    expect(c.headline).toBe(msg)
    expect(c.bodyText).toBe('')
  })

  it('applies the custom message regardless of locale (single override)', () => {
    const msg = 'Custom override text.'
    expect(buildStageAdvanceCopy({ locale: 'it', serviceName: 'Tax Return', stageName: 'Wizard Available', customMessage: msg }).headline).toBe(msg)
  })

  it('ignores a blank/whitespace custom message and falls back to generic', () => {
    const c = buildStageAdvanceCopy({ locale: 'en', serviceName: 'Tax Return', stageName: 'Wizard Available', customMessage: '   ' })
    expect(c.headline).toBe('Your service "Tax Return" has moved to the "Wizard Available" stage.')
    expect(c.bodyText).not.toBe('')
  })

  it('greets without a name when firstName is absent', () => {
    expect(buildStageAdvanceCopy({ locale: 'en', serviceName: 'X', stageName: 'Y' }).greeting).toBe('Hi,')
    expect(buildStageAdvanceCopy({ locale: 'it', serviceName: 'X', stageName: 'Y' }).greeting).toBe('Ciao,')
  })
})
