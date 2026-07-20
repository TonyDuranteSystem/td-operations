import { describe, it, expect } from 'vitest'
import { WIZARD_LABELS, wizardLabelFor, buildWizardReminderTitle } from '@/lib/portal/wizard-reminder-copy'

describe('wizardLabelFor', () => {
  it('has a readable label for both bank-form wizard types (the reported bug)', () => {
    expect(WIZARD_LABELS.banking_relay.en).toBe('Relay Bank Account')
    expect(WIZARD_LABELS.banking_payset.en).toBe('Payset Bank Account')
  })

  it('resolves every known wizard type to a non-empty label', () => {
    for (const type of Object.keys(WIZARD_LABELS)) {
      expect(wizardLabelFor(type).en.length).toBeGreaterThan(0)
    }
  })

  it('falls back to the raw wizard_type only for an unmapped type', () => {
    expect(wizardLabelFor('some_future_wizard').en).toBe('some_future_wizard')
  })
})

describe('buildWizardReminderTitle', () => {
  it('never leaks the internal banking_relay code into client-facing text', () => {
    const title = buildWizardReminderTitle({ urgency: '7d', wizardType: 'banking_relay', companyName: 'THW Global LLC' })
    expect(title).not.toContain('banking_relay')
    expect(title).toBe('Action needed: Complete your Relay Bank Account form — THW Global LLC')
  })

  it('never leaks the internal banking_payset code into client-facing text', () => {
    const title = buildWizardReminderTitle({ urgency: '3d', wizardType: 'banking_payset', companyName: 'PTBT Holding LLC' })
    expect(title).not.toContain('banking_payset')
    expect(title).toBe('Reminder: Complete your Payset Bank Account form — PTBT Holding LLC')
  })

  it('omits the company suffix when no company name is known (e.g. formation before an account exists)', () => {
    const title = buildWizardReminderTitle({ urgency: '7d', wizardType: 'formation', companyName: null })
    expect(title).toBe('Action needed: Complete your Formation form')
  })

  it('omits the company suffix when companyName is undefined', () => {
    const title = buildWizardReminderTitle({ urgency: '7d', wizardType: 'formation' })
    expect(title).toBe('Action needed: Complete your Formation form')
  })

  it('uses the "Action needed" prefix for 7-day and "Reminder" for 3-day, matching current copy', () => {
    expect(buildWizardReminderTitle({ urgency: '7d', wizardType: 'tax', companyName: null })).toMatch(/^Action needed:/)
    expect(buildWizardReminderTitle({ urgency: '3d', wizardType: 'tax', companyName: null })).toMatch(/^Reminder:/)
  })

  it('distinguishes two companies with the same wizard type (the actual reported confusion)', () => {
    const luma = buildWizardReminderTitle({ urgency: '7d', wizardType: 'banking_relay', companyName: 'LUMA Beauty Global LLC' })
    const thw = buildWizardReminderTitle({ urgency: '7d', wizardType: 'banking_relay', companyName: 'THW Global LLC' })
    expect(luma).not.toBe(thw)
    expect(luma).toContain('LUMA Beauty Global LLC')
    expect(thw).toContain('THW Global LLC')
  })
})
