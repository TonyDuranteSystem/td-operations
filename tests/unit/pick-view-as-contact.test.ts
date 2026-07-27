import { describe, it, expect } from 'vitest'
import { isOwnerRole, pickViewAsContactId } from '@/lib/portal/pick-view-as-contact'

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
