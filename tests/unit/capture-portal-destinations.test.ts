import { describe, it, expect } from 'vitest'
import { toCandidates, type ContactRow } from '@/lib/captures/portal-destinations'

function row(overrides: Partial<ContactRow> = {}): ContactRow {
  return {
    id: 'contact-1',
    full_name: 'Jane Doe',
    email: 'jane@example.com',
    portal_email_sent_at: '2026-01-01T00:00:00Z',
    account_contacts: [],
    ...overrides,
  }
}

describe('capture portal destination candidates', () => {
  it('a never-onboarded contact (no portal invite ever sent) produces no candidates at all', () => {
    expect(toCandidates(row({ portal_email_sent_at: null }))).toEqual([])
  })

  it('a contact with no email produces no candidates', () => {
    expect(toCandidates(row({ email: null }))).toEqual([])
  })

  it('an onboarded contact with no companies gets exactly one personal candidate', () => {
    const candidates = toCandidates(row())
    expect(candidates).toEqual([
      { contactId: 'contact-1', contactName: 'Jane Doe', contactEmail: 'jane@example.com', kind: 'personal', accountId: null, companyName: null },
    ])
  })

  it('an Active company produces a company candidate alongside the personal one', () => {
    const candidates = toCandidates(
      row({ account_contacts: [{ account_id: 'acct-1', accounts: { id: 'acct-1', company_name: 'Acme LLC', status: 'Active' } }] }),
    )
    expect(candidates).toHaveLength(2)
    expect(candidates[1]).toEqual({
      contactId: 'contact-1',
      contactName: 'Jane Doe',
      contactEmail: 'jane@example.com',
      kind: 'company',
      accountId: 'acct-1',
      companyName: 'Acme LLC',
    })
  })

  it('a Suspended company still produces a candidate (client can still see the portal)', () => {
    const candidates = toCandidates(
      row({ account_contacts: [{ account_id: 'acct-1', accounts: { id: 'acct-1', company_name: 'Acme LLC', status: 'Suspended' } }] }),
    )
    expect(candidates.some((c) => c.accountId === 'acct-1')).toBe(true)
  })

  it.each(['Closed', 'Cancelled', 'Delinquent', 'Pending-Formation'])(
    'a %s company is silently dropped — the client would never see a message sent there',
    (status) => {
      const candidates = toCandidates(
        row({ account_contacts: [{ account_id: 'acct-1', accounts: { id: 'acct-1', company_name: 'Dead LLC', status } }] }),
      )
      expect(candidates.every((c) => c.accountId !== 'acct-1')).toBe(true)
      // the personal candidate still survives — only the dead company is dropped
      expect(candidates).toHaveLength(1)
    },
  )

  it('two companies, one closed one active — only the active one becomes a candidate', () => {
    const candidates = toCandidates(
      row({
        account_contacts: [
          { account_id: 'acct-dead', accounts: { id: 'acct-dead', company_name: 'Dead LLC', status: 'Closed' } },
          { account_id: 'acct-live', accounts: { id: 'acct-live', company_name: 'Live LLC', status: 'Active' } },
        ],
      }),
    )
    const accountIds = candidates.map((c) => c.accountId)
    expect(accountIds).toContain('acct-live')
    expect(accountIds).not.toContain('acct-dead')
  })

  it('falls back to the email as the display name when full_name is blank', () => {
    const candidates = toCandidates(row({ full_name: null }))
    expect(candidates[0].contactName).toBe('jane@example.com')
  })

  it('a duplicate account_contacts row for the same company does not produce a duplicate candidate', () => {
    const acct = { id: 'acct-1', company_name: 'Acme LLC', status: 'Active' }
    const candidates = toCandidates(
      row({
        account_contacts: [
          { account_id: 'acct-1', accounts: acct },
          { account_id: 'acct-1', accounts: acct },
        ],
      }),
    )
    expect(candidates.filter((c) => c.accountId === 'acct-1')).toHaveLength(1)
  })
})
