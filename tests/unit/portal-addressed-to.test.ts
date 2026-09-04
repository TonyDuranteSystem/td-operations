/**
 * lib/portal/addressed-to.ts unit tests (dev job 08a8be62).
 *
 * pickAddressedToGuess is pure — mirrors resolveAdminReplyContact's cascade
 * (lib/portal/admin-send-scope.ts) but against the FULL members-resolved
 * list, not just account_contacts-linked contacts. resolveAccountMembersForChat
 * resolves the real `members` table (not account_contacts) into addressable
 * options, reusing the email-lookup fallback already proven in
 * lib/members/resolve-signer.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const findContactByEmailScopedToAccountMock = vi.fn()
vi.mock('@/lib/members/resolve-signer', () => ({
  findContactByEmailScopedToAccount: (...args: unknown[]) => findContactByEmailScopedToAccountMock(...args),
}))

let membersRows: Array<Record<string, unknown>> = []
let membersQueryError: { message: string } | null = null

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== 'members') throw new Error(`unexpected table in test: ${table}`)
      const chain = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        order: vi.fn(() => chain),
        then: (resolve: (v: unknown) => void) =>
          resolve({ data: membersQueryError ? null : membersRows, error: membersQueryError }),
      }
      return chain
    },
  },
}))

import { resolveAccountMembersForChat, pickAddressedToGuess, type AddressedToOption } from '@/lib/portal/addressed-to'

const ACC = 'aaaaaaaa-0000-0000-0000-000000000001'

beforeEach(() => {
  membersRows = []
  membersQueryError = null
  findContactByEmailScopedToAccountMock.mockReset()
})

function opt(over: Partial<AddressedToOption> = {}): AddressedToOption {
  return {
    memberId: 'm1', name: 'Mario', contactId: 'c1', isCompanyMember: false, isPrimary: false, resolvable: true,
    ...over,
  }
}

describe('resolveAccountMembersForChat', () => {
  it('resolves an individual member with a direct contact_id', async () => {
    membersRows = [{ id: 'm1', member_type: 'individual', full_name: 'Mario Rossi', company_name: null, contact_id: 'c1', representative_name: null, representative_email: null, email: null, is_primary: true }]
    const result = await resolveAccountMembersForChat(ACC)
    expect(result).toEqual([{ memberId: 'm1', name: 'Mario Rossi', contactId: 'c1', isCompanyMember: false, isPrimary: true, resolvable: true }])
    expect(findContactByEmailScopedToAccountMock).not.toHaveBeenCalled()
  })

  it('falls back to email lookup for an individual member with no contact_id', async () => {
    membersRows = [{ id: 'm2', member_type: 'individual', full_name: 'Luca Bianchi', company_name: null, contact_id: null, representative_name: null, representative_email: null, email: 'luca@example.com', is_primary: false }]
    findContactByEmailScopedToAccountMock.mockResolvedValue({ contactId: 'c2' })
    const result = await resolveAccountMembersForChat(ACC)
    expect(findContactByEmailScopedToAccountMock).toHaveBeenCalledWith(ACC, 'luca@example.com')
    expect(result[0]).toMatchObject({ contactId: 'c2', resolvable: true })
  })

  it('resolves a company-type member via representative_email, name from company_name', async () => {
    membersRows = [{ id: 'm3', member_type: 'company', full_name: null, company_name: 'Indaco LTD', contact_id: null, representative_name: 'Marco Pasetto', representative_email: 'marco@indaco.example', email: null, is_primary: false }]
    findContactByEmailScopedToAccountMock.mockResolvedValue({ contactId: 'c3' })
    const result = await resolveAccountMembersForChat(ACC)
    expect(findContactByEmailScopedToAccountMock).toHaveBeenCalledWith(ACC, 'marco@indaco.example')
    expect(result[0]).toMatchObject({ name: 'Indaco LTD', isCompanyMember: true, contactId: 'c3', resolvable: true })
  })

  it('a company-type member with its OWN contact_id already set uses it directly, never the email fallback', async () => {
    // Real production shape found in council review: a company member's
    // representative_name/email can be blank while contact_id still resolves.
    membersRows = [{ id: 'm4', member_type: 'company', full_name: null, company_name: 'Advertising Apex LLC', contact_id: 'c4', representative_name: null, representative_email: null, email: null, is_primary: false }]
    const result = await resolveAccountMembersForChat(ACC)
    expect(findContactByEmailScopedToAccountMock).not.toHaveBeenCalled()
    expect(result[0]).toMatchObject({ contactId: 'c4', resolvable: true })
  })

  it('marks a member unresolvable when the email lookup comes back ambiguous — never guesses', async () => {
    membersRows = [{ id: 'm5', member_type: 'individual', full_name: 'Shared Email Guy', company_name: null, contact_id: null, representative_name: null, representative_email: null, email: 'shared@example.com', is_primary: false }]
    findContactByEmailScopedToAccountMock.mockResolvedValue({ contactId: null, ambiguous: true })
    const result = await resolveAccountMembersForChat(ACC)
    expect(result[0]).toMatchObject({ contactId: null, resolvable: false })
  })

  it('marks a member unresolvable when there is no contact_id and no email at all', async () => {
    membersRows = [{ id: 'm6', member_type: 'individual', full_name: 'No Contact Info', company_name: null, contact_id: null, representative_name: null, representative_email: null, email: null, is_primary: false }]
    const result = await resolveAccountMembersForChat(ACC)
    expect(findContactByEmailScopedToAccountMock).not.toHaveBeenCalled()
    expect(result[0]).toMatchObject({ contactId: null, resolvable: false })
  })

  it('fails closed (empty list, never throws) on a DB error — same posture as decideAdminSendScope\'s link check', async () => {
    membersRows = []
    membersQueryError = { message: 'connection reset' }
    const result = await resolveAccountMembersForChat(ACC)
    expect(result).toEqual([])
  })
})

describe('pickAddressedToGuess (pure)', () => {
  it('returns null when there are no resolvable options', () => {
    expect(pickAddressedToGuess({ options: [opt({ resolvable: false, contactId: null })], replyToContactId: null, lastClientContactId: null })).toBeNull()
    expect(pickAddressedToGuess({ options: [], replyToContactId: null, lastClientContactId: null })).toBeNull()
  })

  it('prefers the reply-to message\'s author over everything else', () => {
    const options = [opt({ memberId: 'm1', contactId: 'c1', isPrimary: true }), opt({ memberId: 'm2', contactId: 'c2' })]
    const result = pickAddressedToGuess({ options, replyToContactId: 'c2', lastClientContactId: 'c1' })
    expect(result?.contactId).toBe('c2')
  })

  it('falls back to the last client sender when there is no reply-to match', () => {
    const options = [opt({ memberId: 'm1', contactId: 'c1', isPrimary: true }), opt({ memberId: 'm2', contactId: 'c2' })]
    const result = pickAddressedToGuess({ options, replyToContactId: null, lastClientContactId: 'c2' })
    expect(result?.contactId).toBe('c2')
  })

  it('ignores a reply-to/last-sender contact that is not actually in the resolved options', () => {
    const options = [opt({ memberId: 'm1', contactId: 'c1', isPrimary: true })]
    const result = pickAddressedToGuess({ options, replyToContactId: 'c-not-a-member', lastClientContactId: 'c-also-not' })
    expect(result?.contactId).toBe('c1')
  })

  it('falls back to the primary member when there is no reply-to or last-sender signal', () => {
    const options = [opt({ memberId: 'm1', contactId: 'c1', isPrimary: false }), opt({ memberId: 'm2', contactId: 'c2', isPrimary: true })]
    const result = pickAddressedToGuess({ options, replyToContactId: null, lastClientContactId: null })
    expect(result?.contactId).toBe('c2')
  })

  it('falls back to a stable first-by-contactId pick when nothing else applies', () => {
    const options = [opt({ memberId: 'm1', contactId: 'zzz', isPrimary: false }), opt({ memberId: 'm2', contactId: 'aaa', isPrimary: false })]
    const result = pickAddressedToGuess({ options, replyToContactId: null, lastClientContactId: null })
    expect(result?.contactId).toBe('aaa')
  })

  it('never picks an unresolvable option, even as the reply-to author', () => {
    const options = [
      opt({ memberId: 'm1', contactId: null, resolvable: false, isPrimary: true }),
      opt({ memberId: 'm2', contactId: 'c2', isPrimary: false }),
    ]
    const result = pickAddressedToGuess({ options, replyToContactId: null, lastClientContactId: null })
    expect(result?.contactId).toBe('c2')
  })
})
