/**
 * Unit tests for resolveWizardProgressScope (lib/portal/wizard-scope.ts).
 *
 * Covers the wizard-progress lookup precedence that decides whether the portal
 * finds an existing formation (and avoids the duplicate-formation bug) without
 * disturbing PR #75's new-company (?lead=) flow. dev_task 21fd1f4a.
 */

import { describe, it, expect } from 'vitest'
import { resolveWizardProgressScope, accountIdForWizardSubmission } from '@/lib/portal/wizard-scope'

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

  // ── Person-owned (ITIN) — the ITIN belongs to the person, never the company.
  // Regression cover for Pietro De Pellegrino (2026-07-21): a standalone ITIN
  // buyer who ALSO owns a company. Before this, an account holder's ITIN
  // progress keyed on the account, so two members of one LLC shared one row.

  it('Scenario: ITIN buyer who owns a company → contact_id, NOT the account', () => {
    expect(
      resolveWizardProgressScope({ wizardType: 'itin', formationLeadId: null, accountId: A, contactId: C }),
    ).toEqual({ col: 'contact_id', val: C, restrictToNoLead: false })
  })

  it('Scenario: ITIN buyer with no company → contact_id (unchanged)', () => {
    expect(
      resolveWizardProgressScope({ wizardType: 'itin', formationLeadId: null, accountId: null, contactId: C }),
    ).toEqual({ col: 'contact_id', val: C, restrictToNoLead: false })
  })

  it('ITIN does NOT inherit formation restrictToNoLead — an ITIN sold inside a formation offer can carry a lead', () => {
    // Formation sets restrictToNoLead so a second company's draft is not picked
    // up. That disambiguation has no meaning for an ITIN, and inheriting it
    // would hide a lead-stamped ITIN row and re-offer an already-filed wizard.
    const scope = resolveWizardProgressScope({
      wizardType: 'itin', formationLeadId: null, accountId: A, contactId: C,
    })
    expect(scope?.restrictToNoLead).toBe(false)
  })

  it('two members of one LLC resolve to DIFFERENT rows (LUMA Beauty Global shape)', () => {
    // Both hold their own ITIN on the same account. Keyed on the account they
    // would collide — person B would load person A's passport and date of
    // birth, and B's own submit would be a silent no-op.
    const a = resolveWizardProgressScope({ wizardType: 'itin', formationLeadId: null, accountId: A, contactId: 'adam' })
    const b = resolveWizardProgressScope({ wizardType: 'itin', formationLeadId: null, accountId: A, contactId: 'peter' })
    expect(a).not.toEqual(b)
    expect(a?.val).toBe('adam')
    expect(b?.val).toBe('peter')
  })

  it('an explicit lead scope still wins over person-ownership', () => {
    expect(
      resolveWizardProgressScope({ wizardType: 'itin', formationLeadId: L, accountId: A, contactId: C }),
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

describe('accountIdForWizardSubmission (THW Global hijack backstop, dev_task 358e8cbe)', () => {
  it('formation NEVER carries an account_id — even when the client sent one', () => {
    // The hijack: an existing client (Adam Mihaly / THW Global) reached the
    // formation wizard without ?lead=, so the client posted account_id=THW.
    // The server must drop it so the new company never binds to the old one.
    expect(accountIdForWizardSubmission('formation', A)).toBeNull()
  })

  it('formation with no account stays null', () => {
    expect(accountIdForWizardSubmission('formation', null)).toBeNull()
    expect(accountIdForWizardSubmission('formation', undefined)).toBeNull()
  })

  it('non-formation wizards keep their account_id (banking/tax submit to the existing company)', () => {
    expect(accountIdForWizardSubmission('banking_payset', A)).toBe(A)
    expect(accountIdForWizardSubmission('tax', A)).toBe(A)
    expect(accountIdForWizardSubmission('onboarding', A)).toBe(A)
  })

  it('ITIN NEVER carries an account_id — it belongs to the person, matching createSD', () => {
    // createSD strips account_id from every ITIN service delivery. If the
    // submission kept one, two members of one LLC would share a single
    // company-keyed submission and the second person could never file.
    expect(accountIdForWizardSubmission('itin', A)).toBeNull()
    expect(accountIdForWizardSubmission('itin', null)).toBeNull()
    expect(accountIdForWizardSubmission('itin', undefined)).toBeNull()
  })

  it('non-formation with no account normalizes undefined → null', () => {
    expect(accountIdForWizardSubmission('banking_relay', undefined)).toBeNull()
    expect(accountIdForWizardSubmission('closure', null)).toBeNull()
  })
})
