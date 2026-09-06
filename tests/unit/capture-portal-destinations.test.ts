import { describe, it, expect, vi } from 'vitest'
import { toCandidates, type ContactRow } from '@/lib/captures/portal-destinations'

// Captures exactly what each pass's .select() was called with, so the
// regression this bug hunt found -- the company-name pass's select string
// carrying a SECOND, differently-joined embed of account_contacts on top of
// the contact-name pass's own plain embed, which silently broke the
// .ilike("account_contacts.accounts.company_name", ...) filter and made
// every company-name search return zero rows -- can never silently come
// back. Two independent contact rows so the two passes are distinguishable
// by which query "found" them: a company row that would ONLY ever surface
// via the company-name pass (its own name/email cannot match anything).
const contactRow: ContactRow = {
  id: 'contact-name-match',
  full_name: 'Jane Doe',
  email: 'jane@example.com',
  portal_email_sent_at: '2026-01-01T00:00:00Z',
  account_contacts: [],
}
const companyRow: ContactRow = {
  id: 'company-name-match',
  full_name: 'Someone Else',
  email: 'someone@example.com',
  portal_email_sent_at: '2026-01-01T00:00:00Z',
  account_contacts: [{ account_id: 'acct-1', accounts: { id: 'acct-1', company_name: 'Acme Widgets LLC', status: 'Active' } }],
}

const selectCalls = vi.hoisted(() => [] as string[])

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => ({
      select: (cols: string) => {
        selectCalls.push(cols)
        // one shared thenable so both .or(...) and .ilike(...) chain off it
        const builder = {
          or: () => builder,
          ilike: (col: string) => {
            // only the company-name pass filters this way -- return the row
            // that's only findable through a real, working nested-embed filter
            return col === 'account_contacts.accounts.company_name'
              ? { limit: async () => ({ data: [companyRow], error: null }) }
              : builder
          },
          limit: async () =>
            // the contact-name pass (.or() then .limit()) returns the contact match
            ({ data: cols.includes('!inner') ? [] : [contactRow], error: null }),
        }
        return builder
      },
    }),
  },
}))

const { searchPortalDestinations } = await import('@/lib/captures/portal-destinations')

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

describe('searchPortalDestinations — the two query passes', () => {
  it('the company-name pass selects account_contacts/accounts exactly once each, both inner-joined', async () => {
    selectCalls.length = 0
    await searchPortalDestinations('widgets')
    const companyPassCols = selectCalls.find((c) => c.includes('!inner'))
    expect(companyPassCols).toBeDefined()
    // the exact bug: a select string carrying a SECOND, plain embed of the
    // same relation alongside the inner-joined one. Count occurrences of the
    // embed key so a reintroduced duplicate — inner or not — fails this test.
    expect(companyPassCols!.match(/account_contacts/g)).toHaveLength(1)
    expect(companyPassCols!.match(/accounts/g)).toHaveLength(1)
  })

  it('a company-name search finds a contact reachable ONLY through their company name, not their own name/email', async () => {
    const candidates = await searchPortalDestinations('widgets')
    expect(candidates.some((c) => c.contactId === 'company-name-match' && c.companyName === 'Acme Widgets LLC')).toBe(true)
  })

  it('a contact-name search still finds a contact with no linked companies at all', async () => {
    const candidates = await searchPortalDestinations('jane')
    expect(candidates.some((c) => c.contactId === 'contact-name-match' && c.kind === 'personal')).toBe(true)
  })

  it('a query under 2 characters short-circuits without querying either pass', async () => {
    selectCalls.length = 0
    const candidates = await searchPortalDestinations('a')
    expect(candidates).toEqual([])
    expect(selectCalls).toHaveLength(0)
  })
})
