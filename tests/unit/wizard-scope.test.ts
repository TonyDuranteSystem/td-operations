/**
 * Unit tests for resolveWizardProgressScope (lib/portal/wizard-scope.ts).
 *
 * Covers the wizard-progress lookup precedence that decides whether the portal
 * finds an existing formation (and avoids the duplicate-formation bug) without
 * disturbing PR #75's new-company (?lead=) flow. dev_task 21fd1f4a.
 */

import { describe, it, expect } from 'vitest'
import { resolveWizardProgressScope } from '@/lib/portal/wizard-scope'

const C = 'contact-1'
const A = 'account-1'
const L = 'lead-1'

describe('resolveWizardProgressScope', () => {
  it('Scenario: new-company formation via ?lead= → keyed on lead_id (PR #75 untouched)', () => {
    expect(
      resolveWizardProgressScope({ wizardType: 'formation', formationLeadId: L, accountId: A, contactId: C }),
    ).toEqual({ col: 'lead_id', val: L, restrictToNoLead: false })
  })

  it('Scenario: materialized formation, normal login (Lorenzo) → contact_id, no-lead only', () => {
    // Account exists, but formation lives on the contact — must look by contact,
    // restricted to the original (lead_id IS NULL) row.
    expect(
      resolveWizardProgressScope({ wizardType: 'formation', formationLeadId: null, accountId: A, contactId: C }),
    ).toEqual({ col: 'contact_id', val: C, restrictToNoLead: true })
  })

  it('Scenario: formation before any account → still contact_id, no-lead only', () => {
    expect(
      resolveWizardProgressScope({ wizardType: 'formation', formationLeadId: null, accountId: null, contactId: C }),
    ).toEqual({ col: 'contact_id', val: C, restrictToNoLead: true })
  })

  it('Scenario: account-owned wizard (banking) with an account → account_id', () => {
    expect(
      resolveWizardProgressScope({ wizardType: 'banking_payset', formationLeadId: null, accountId: A, contactId: C }),
    ).toEqual({ col: 'account_id', val: A, restrictToNoLead: false })
  })

  it('Scenario: account-owned wizard (tax) with an account → account_id', () => {
    expect(
      resolveWizardProgressScope({ wizardType: 'tax', formationLeadId: null, accountId: A, contactId: C }),
    ).toEqual({ col: 'account_id', val: A, restrictToNoLead: false })
  })

  it('Scenario: account-owned wizard, pre-account (no account yet) → contact_id fallback', () => {
    expect(
      resolveWizardProgressScope({ wizardType: 'onboarding', formationLeadId: null, accountId: null, contactId: C }),
    ).toEqual({ col: 'contact_id', val: C, restrictToNoLead: false })
  })

  it('lead scope wins even for an account-owned wizard type (defensive — only formation offers set a lead)', () => {
    expect(
      resolveWizardProgressScope({ wizardType: 'banking', formationLeadId: L, accountId: A, contactId: C }),
    ).toEqual({ col: 'lead_id', val: L, restrictToNoLead: false })
  })

  it('returns null when no identifiers are available', () => {
    expect(
      resolveWizardProgressScope({ wizardType: 'formation', formationLeadId: null, accountId: null, contactId: null }),
    ).toBeNull()
  })

  it('empty-string account/contact are treated as absent (falsy)', () => {
    expect(
      resolveWizardProgressScope({ wizardType: 'onboarding', formationLeadId: null, accountId: '', contactId: '' }),
    ).toBeNull()
  })
})
