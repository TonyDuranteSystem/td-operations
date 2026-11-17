import { describe, it, expect } from 'vitest'
import { canSubmitWizard, teammateMayUseWizard } from '@/lib/portal/wizard-submit-access'
import type { PortalIdentity } from '@/lib/portal/resolve-portal-identity'

const contact = (contactId: string, accountIds: string[]): PortalIdentity => ({
  kind: 'contact',
  contactId,
  accountIds,
})
const none: PortalIdentity = { kind: 'none' }

describe('canSubmitWizard — contact', () => {
  const id = contact('C1', ['ACC-X', 'ACC-Z'])

  it('allows an account-scoped submit for a linked company', () => {
    expect(canSubmitWizard(id, 'ACC-X', 'C1')).toBe(true)
  })

  it('BLOCKS submitting onto a company the contact is NOT linked to (the leak)', () => {
    expect(canSubmitWizard(id, 'ACC-Y', 'C1')).toBe(false)
  })

  it('allows a formation/individual submit (no account) for the logged-in contact', () => {
    // formation: accountIdForWizardSubmission already nulled the account
    expect(canSubmitWizard(id, null, 'C1')).toBe(true)
  })

  it('BLOCKS submitting under a different contact_id', () => {
    expect(canSubmitWizard(id, null, 'C2')).toBe(false)
    expect(canSubmitWizard(id, 'ACC-X', 'C2')).toBe(false)
  })

  it('allows when neither account nor contact is targeted', () => {
    expect(canSubmitWizard(id, null, null)).toBe(true)
  })
})

describe('canSubmitWizard — person-owned wizard (ITIN)', () => {
  it('allows the ITIN owner to submit their own (no account scope by design)', () => {
    expect(canSubmitWizard(contact('C1', ['ACC-X']), null, 'C1', 'itin')).toBe(true)
  })

  it('BLOCKS a contact submitting an ITIN under someone else', () => {
    expect(canSubmitWizard(contact('C1', ['ACC-X']), null, 'C2', 'itin')).toBe(false)
  })
})

const teamWith = (accountId: string, capabilities: Record<string, boolean>): PortalIdentity =>
  ({ kind: 'teammate', accountId, teamMemberId: 'tm-1', displayName: 'T', email: null, capabilities } as PortalIdentity)
const everyTick = {
  documents: true, invoices_billing: true, chat: true, company_services: true,
  bank_applications: true, sales_customers: true, company_data_form: true,
  announcements: true, payment_links: true, invoice_history: true,
}

describe('canSubmitWizard — teammate (only the wizards a tick covers)', () => {
  it('a login with NO ticks cannot submit ANY wizard (the hole)', () => {
    const noTicks = teamWith('ACC-X', {})
    for (const type of ['tax', 'closure', 'itin', 'formation', 'onboarding', 'banking_payset', 'banking_relay', 'company_info', 'td_communication', 'nonsense', undefined]) {
      expect(canSubmitWizard(noTicks, 'ACC-X', null, type)).toBe(false)
    }
  })

  it('the Bank applications tick opens the bank application (Payset / Relay) for its own company', () => {
    const id = teamWith('ACC-X', { bank_applications: true })
    expect(canSubmitWizard(id, 'ACC-X', null, 'banking_payset')).toBe(true)
    expect(canSubmitWizard(id, 'ACC-X', null, 'banking_relay')).toBe(true)
    expect(canSubmitWizard(id, 'ACC-X', null, 'onboarding')).toBe(false)
  })

  it('the Company data form tick opens the onboarding form for its own company, and nothing else', () => {
    const id = teamWith('ACC-X', { company_data_form: true })
    expect(canSubmitWizard(id, 'ACC-X', null, 'onboarding')).toBe(true)
    expect(canSubmitWizard(id, 'ACC-X', null, 'banking_payset')).toBe(false)
  })

  it('NO tick — not even all of them — ever opens tax, tax confirmation, ITIN, closure, formation or the TD Communication audit', () => {
    const id = teamWith('ACC-X', everyTick)
    for (const type of ['tax', 'tax_return', 'company_info', 'itin', 'closure', 'formation', 'td_communication', 'nonsense', undefined]) {
      expect(canSubmitWizard(id, 'ACC-X', null, type)).toBe(false)
    }
  })

  it('BLOCKS a submit for a different company even with the right tick', () => {
    const id = teamWith('ACC-X', { bank_applications: true })
    expect(canSubmitWizard(id, 'ACC-Y', null, 'banking_payset')).toBe(false)
  })

  it('allows the tick-covered wizard when no account is targeted (the server scopes it)', () => {
    expect(canSubmitWizard(teamWith('ACC-X', { bank_applications: true }), null, null, 'banking_payset')).toBe(true)
  })
})

describe('teammateMayUseWizard', () => {
  it('opens the bank picker only with the Bank applications tick', () => {
    expect(teammateMayUseWizard({ bank_applications: true }, 'banking')).toBe(true)
    expect(teammateMayUseWizard({}, 'banking')).toBe(false)
    expect(teammateMayUseWizard(null, 'banking_payset')).toBe(false)
    expect(teammateMayUseWizard(undefined, 'onboarding')).toBe(false)
  })
})

describe('canSubmitWizard — none', () => {
  it('denies when there is no resolvable portal identity', () => {
    expect(canSubmitWizard(none, null, null)).toBe(false)
    expect(canSubmitWizard(none, 'ACC-X', 'C1')).toBe(false)
  })
})
