import { describe, it, expect } from 'vitest'
import { isOwnerRole, pickViewAsContactId, pickViewAsFallback } from '@/lib/portal/pick-view-as-contact'

describe('isOwnerRole', () => {
  it('matches every casing of owner', () => {
    expect(isOwnerRole('owner')).toBe(true)
    expect(isOwnerRole('Owner')).toBe(true)
    expect(isOwnerRole('OWNER')).toBe(true)
    expect(isOwnerRole('  owner  ')).toBe(true)
  })

  it('rejects other roles and empty values', () => {
    expect(isOwnerRole('Member')).toBe(false)
    expect(isOwnerRole('member')).toBe(false)
    expect(isOwnerRole('Sole Member')).toBe(false)
    expect(isOwnerRole('')).toBe(false)
    expect(isOwnerRole(null)).toBe(false)
    expect(isOwnerRole(undefined)).toBe(false)
  })
})

describe('pickViewAsContactId', () => {
  const logins = (...ids: string[]) => new Set(ids)

  it('prefers the owner when the owner has a login (any casing)', () => {
    const contacts = [
      { id: 'b-member', role: 'Member' },
      { id: 'a-owner', role: 'owner' },
    ]
    expect(pickViewAsContactId(contacts, logins('a-owner', 'b-member'))).toBe('a-owner')
  })

  it('skips an owner with NO login and falls to a member WITH one (the Nexo shape)', () => {
    // Laurel: owner-role link, no auth user. Peter: Member links, has logins.
    const contacts = [
      { id: 'laurel', role: 'owner' },
      { id: 'peter-info', role: 'Member' },
      { id: 'radomir', role: 'Member' },
    ]
    expect(pickViewAsContactId(contacts, logins('peter-info'))).toBe('peter-info')
  })

  // MUTATION GUARD. The earlier owner test had the owner sorting FIRST, so
  // replacing the owner lookup with `viewable[0]` kept every test green — the
  // rule the feature exists for was unprotected. Here the owner sorts LAST, so
  // this fails the moment owner-preference is removed.
  it('prefers the owner even when the owner sorts AFTER a member', () => {
    const contacts = [
      { id: 'aaa-member', role: 'Member' },
      { id: 'zzz-owner', role: 'owner' },
    ]
    expect(pickViewAsContactId(contacts, logins('aaa-member', 'zzz-owner'))).toBe('zzz-owner')
  })

  it('prefers a capital-O Owner that sorts after a member too', () => {
    const contacts = [
      { id: 'aaa-member', role: 'Member' },
      { id: 'zzz-owner', role: 'Owner' },
    ]
    expect(pickViewAsContactId(contacts, logins('aaa-member', 'zzz-owner'))).toBe('zzz-owner')
  })

  it('is deterministic regardless of input order', () => {
    const a = [
      { id: 'ccc', role: 'Member' },
      { id: 'aaa', role: 'Member' },
    ]
    const b = [...a].reverse()
    const withLogins = logins('aaa', 'ccc')
    expect(pickViewAsContactId(a, withLogins)).toBe('aaa')
    expect(pickViewAsContactId(b, withLogins)).toBe('aaa')
  })

  it('returns null when nobody on the account has a login', () => {
    const contacts = [
      { id: 'laurel', role: 'owner' },
      { id: 'radomir', role: 'Member' },
    ]
    expect(pickViewAsContactId(contacts, logins())).toBeNull()
  })

  it('returns null for an account with no contacts', () => {
    expect(pickViewAsContactId([], logins('x'))).toBeNull()
  })

  it('ignores malformed candidates instead of crashing', () => {
    const contacts = [
      { id: '', role: 'owner' },
      { id: 'good', role: null },
    ]
    expect(pickViewAsContactId(contacts, logins('good'))).toBe('good')
  })
})

describe('pickViewAsFallback', () => {
  const logins = (...ids: string[]) => new Set(ids)
  const needsSetup = (...ids: string[]) => new Set(ids)

  it('uses the resolved signer directly when they have finished setup — unchanged best case, no note', () => {
    const contacts = [{ id: 'signer', full_name: 'Signer Name' }, { id: 'other', full_name: 'Other' }]
    const result = pickViewAsFallback({
      contacts,
      resolvedSignerId: 'signer',
      loginHolders: logins('signer', 'other'),
      needsSetupIds: needsSetup(),
      currentMemberContactIds: null,
    })
    expect(result).toEqual({ contactId: 'signer', note: null })
  })

  it('the KS Media Consulting LLC shape: falls back to the co-member who finished setup, with a note', () => {
    const contacts = [
      { id: 'botond', full_name: 'Botond Dudas' },
      { id: 'aron', full_name: 'Aron Toth' },
    ]
    const result = pickViewAsFallback({
      contacts,
      resolvedSignerId: 'botond',
      loginHolders: logins('botond', 'aron'),
      needsSetupIds: needsSetup('botond'),
      currentMemberContactIds: new Set(['botond', 'aron']),
    })
    expect(result.contactId).toBe('aron')
    expect(result.note).toBe(
      "Botond Dudas hasn't finished setting up their portal account yet — showing you Aron Toth's view instead, since they have.",
    )
  })

  it('REGRESSION (bug-hunter, 2026-08-21): never substitutes a departed member whose account_contacts link is stale — member removal deletes the members row but not the junction row', () => {
    const contacts = [
      { id: 'new-signer', full_name: 'New Signer' }, // current member, stuck setup
      { id: 'departed', full_name: 'Departed Member' }, // removed from members, but still linked in account_contacts, finished setup long ago
    ]
    const result = pickViewAsFallback({
      contacts,
      resolvedSignerId: 'new-signer',
      loginHolders: logins('new-signer', 'departed'),
      needsSetupIds: needsSetup('new-signer'),
      // Only new-signer is a CURRENT member — departed was removed from the roster.
      currentMemberContactIds: new Set(['new-signer']),
    })
    // Must land on the signer's own stuck screen, NEVER on the departed member.
    expect(result.contactId).toBe('new-signer')
    expect(result.note).toBeNull()
  })

  it('note correctly says "no login yet" (not "hasn\'t finished setting up") when the signer has zero login at all', () => {
    const contacts = [
      { id: 'no-login-signer', full_name: 'No Login Signer' },
      { id: 'ready', full_name: 'Ready Member' },
    ]
    const result = pickViewAsFallback({
      contacts,
      resolvedSignerId: 'no-login-signer',
      loginHolders: logins('ready'), // signer has no login row at all
      needsSetupIds: needsSetup(),
      currentMemberContactIds: null,
    })
    expect(result.contactId).toBe('ready')
    expect(result.note).toBe(
      "No Login Signer doesn't have a portal login yet — showing you Ready Member's view instead, since they have.",
    )
  })

  it('lands on the resolved signer\'s own stuck screen, no note, when NOBODY on the account has finished setup', () => {
    const contacts = [
      { id: 'signer', full_name: 'Signer' },
      { id: 'other', full_name: 'Other' },
    ]
    const result = pickViewAsFallback({
      contacts,
      resolvedSignerId: 'signer',
      loginHolders: logins('signer', 'other'),
      needsSetupIds: needsSetup('signer', 'other'), // both stuck
      currentMemberContactIds: new Set(['signer', 'other']),
    })
    expect(result).toEqual({ contactId: 'signer', note: null })
  })

  it('with no resolved signer at all, still prefers a finished-setup contact over an unfinished one — no note (nothing was substituted away from)', () => {
    const contacts = [
      { id: 'unfinished', full_name: 'Unfinished' },
      { id: 'finished', full_name: 'Finished' },
    ]
    const result = pickViewAsFallback({
      contacts,
      resolvedSignerId: null,
      loginHolders: logins('unfinished', 'finished'),
      needsSetupIds: needsSetup('unfinished'),
      currentMemberContactIds: null,
    })
    expect(result.contactId).toBe('finished')
    expect(result.note).toBeNull()
  })

  it('SMLLC/legacy account with no members roster (currentMemberContactIds null) is unrestricted, matching pre-existing behavior', () => {
    const contacts = [
      { id: 'signer', full_name: 'Signer' },
      { id: 'linked-contact', full_name: 'Linked Contact' },
    ]
    const result = pickViewAsFallback({
      contacts,
      resolvedSignerId: 'signer',
      loginHolders: logins('signer', 'linked-contact'),
      needsSetupIds: needsSetup('signer'),
      currentMemberContactIds: null, // no members table in use for this account
    })
    expect(result.contactId).toBe('linked-contact')
  })

  it('never fabricates a substitution note when the fallback picks the exact same person the resolved-signer path would have', () => {
    // resolvedSignerId is null, so there's nobody to be "substituted away from".
    const contacts = [{ id: 'only-one', full_name: 'Only One' }]
    const result = pickViewAsFallback({
      contacts,
      resolvedSignerId: null,
      loginHolders: logins('only-one'),
      needsSetupIds: needsSetup(),
      currentMemberContactIds: null,
    })
    expect(result).toEqual({ contactId: 'only-one', note: null })
  })
})
