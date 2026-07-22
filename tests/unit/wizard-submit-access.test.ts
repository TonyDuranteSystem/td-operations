import { describe, it, expect } from 'vitest'
import { canSubmitWizard } from '@/lib/portal/wizard-submit-access'
import type { PortalIdentity } from '@/lib/portal/resolve-portal-identity'

const contact = (contactId: string, accountIds: string[]): PortalIdentity => ({
  kind: 'contact',
  contactId,
  accountIds,
})
const teammate = (accountId: string): PortalIdentity =>
  ({ kind: 'teammate', accountId, teamMemberId: 'tm-1' } as PortalIdentity)
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

  it('BLOCKS a teammate from submitting an ITIN at all', () => {
    // An ITIN files a federal application in a named individual's name and
    // writes that person's identity fields onto their contact record. A
    // teammate is scoped to a company and has no contact identity, so there is
    // no person they could legitimately file for. The company-scope check
    // cannot catch this: ITIN submissions deliberately carry no account_id, so
    // without an explicit denial the teammate branch would pass unconditionally.
    expect(canSubmitWizard(teammate('ACC-X'), null, 'C1', 'itin')).toBe(false)
    expect(canSubmitWizard(teammate('ACC-X'), 'ACC-X', 'C1', 'itin')).toBe(false)
  })

  it('a teammate can still submit a company-owned wizard (unchanged)', () => {
    expect(canSubmitWizard(teammate('ACC-X'), 'ACC-X', null, 'tax')).toBe(true)
  })
})

describe('canSubmitWizard — teammate', () => {
  const id = teammate('ACC-X')

  it('allows a submit for the teammate’s own company', () => {
    expect(canSubmitWizard(id, 'ACC-X', null)).toBe(true)
  })

  it('BLOCKS a submit for a different company', () => {
    expect(canSubmitWizard(id, 'ACC-Y', null)).toBe(false)
  })

  it('allows when no account is targeted', () => {
    expect(canSubmitWizard(id, null, null)).toBe(true)
  })
})

describe('canSubmitWizard — none', () => {
  it('denies when there is no resolvable portal identity', () => {
    expect(canSubmitWizard(none, null, null)).toBe(false)
    expect(canSubmitWizard(none, 'ACC-X', 'C1')).toBe(false)
  })
})
