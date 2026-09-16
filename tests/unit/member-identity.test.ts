import { describe, it, expect } from 'vitest'
import {
  normalizePersonName,
  normalizeEmail,
  firstDuplicateIndividualIdentity,
  matchContactByName,
  type IdentityMember,
} from '@/lib/members/member-identity'

describe('normalizePersonName', () => {
  it('trims, lowercases, and collapses whitespace', () => {
    expect(normalizePersonName('  Gabriele   Finelli ')).toBe('gabriele finelli')
  })

  it('treats precomposed and decomposed accents as equal (NFC)', () => {
    const precomposed = 'Nicolò Rossi' // "Nicolò" with single codepoint
    const decomposed = 'Nicolò Rossi' // "Nicolo" + combining grave accent
    expect(normalizePersonName(precomposed)).toBe(normalizePersonName(decomposed))
  })

  it('preserves accents (does not strip them) so different letters stay different', () => {
    expect(normalizePersonName('José')).not.toBe(normalizePersonName('Jose'))
  })

  it('handles null/undefined/empty', () => {
    expect(normalizePersonName(null)).toBe('')
    expect(normalizePersonName(undefined)).toBe('')
    expect(normalizePersonName('   ')).toBe('')
  })
})

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Finelli.G23@Gmail.com ')).toBe('finelli.g23@gmail.com')
  })
  it('handles null', () => {
    expect(normalizeEmail(null)).toBe('')
  })
})

describe('firstDuplicateIndividualIdentity', () => {
  it('allows two individual members sharing an email with DIFFERENT names', () => {
    const members: IdentityMember[] = [
      { member_type: 'individual', full_name: 'Gabriele Finelli', email: 'finelli.g23@gmail.com' },
      { member_type: 'individual', full_name: 'Matthew Finelli', email: 'finelli.g23@gmail.com' },
    ]
    expect(firstDuplicateIndividualIdentity(members)).toBeNull()
  })

  it('rejects two individual members with the SAME name and email', () => {
    const members: IdentityMember[] = [
      { member_type: 'individual', full_name: 'Gabriele Finelli', email: 'finelli.g23@gmail.com' },
      { member_type: 'individual', full_name: ' gabriele  finelli ', email: 'Finelli.G23@gmail.com' },
    ]
    expect(firstDuplicateIndividualIdentity(members)).toBe('gabriele  finelli')
  })

  it('does NOT flag a company member sharing name+email with an individual member', () => {
    const members: IdentityMember[] = [
      { member_type: 'individual', full_name: 'John Doe', email: 'john@x.com' },
      { member_type: 'company', full_name: 'John Doe', email: 'john@x.com' },
    ]
    expect(firstDuplicateIndividualIdentity(members)).toBeNull()
  })

  it('skips a member with NO email entirely (carries null contact_id, cannot collide)', () => {
    const members: IdentityMember[] = [
      { member_type: 'individual', full_name: '', email: '' },
      { member_type: 'individual', full_name: '', email: '' },
    ]
    expect(firstDuplicateIndividualIdentity(members)).toBeNull()
  })

  // REGRESSION (2026-07-23 finding, previously unfixed): this used to assert
  // toBeNull() here -- i.e. it PINNED the bug as correct. Two nameless members
  // sharing one email were both silently skipped by the old `!name || !email`
  // check, so neither was ever added to `seen` and the collision was never
  // caught -- it surfaced later as a raw duplicate-key error at save instead of
  // this clear, pre-save message.
  it('catches two NAMELESS members sharing the same email', () => {
    const members: IdentityMember[] = [
      { member_type: 'individual', full_name: '', email: 'x@y.com' },
      { member_type: 'individual', full_name: '', email: 'X@Y.com' },
    ]
    expect(firstDuplicateIndividualIdentity(members)).toBe('x@y.com')
  })

  it('does NOT flag two nameless members with genuinely DIFFERENT emails', () => {
    const members: IdentityMember[] = [
      { member_type: 'individual', full_name: '', email: 'x@y.com' },
      { member_type: 'individual', full_name: '', email: 'z@y.com' },
    ]
    expect(firstDuplicateIndividualIdentity(members)).toBeNull()
  })

  it('does NOT flag a nameless member against a named member on a different email', () => {
    const members: IdentityMember[] = [
      { member_type: 'individual', full_name: 'Gabriele Finelli', email: 'finelli.g23@gmail.com' },
      { member_type: 'individual', full_name: '', email: 'other@x.com' },
    ]
    expect(firstDuplicateIndividualIdentity(members)).toBeNull()
  })

  it('returns null for a single member', () => {
    expect(firstDuplicateIndividualIdentity([
      { member_type: 'individual', full_name: 'Solo Owner', email: 'solo@x.com' },
    ])).toBeNull()
  })
})

describe('matchContactByName', () => {
  const contacts = [
    { id: 'gab', full_name: 'Gabriele Finelli' },
    { id: 'matt', full_name: 'Matthew Finelli' },
  ]

  it('picks the contact whose name matches (not an arbitrary same-email row)', () => {
    expect(matchContactByName(contacts, 'Gabriele Finelli')).toBe('gab')
    expect(matchContactByName(contacts, 'matthew finelli')).toBe('matt')
  })

  it('returns null when no name matches (caller then creates a new contact)', () => {
    expect(matchContactByName(contacts, 'Someone Else')).toBeNull()
  })

  it('returns null for empty target name', () => {
    expect(matchContactByName(contacts, '')).toBeNull()
    expect(matchContactByName(contacts, null)).toBeNull()
  })

  it('returns null against an empty contact list', () => {
    expect(matchContactByName([], 'Gabriele Finelli')).toBeNull()
  })
})
