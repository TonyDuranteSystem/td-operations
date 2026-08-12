/**
 * Dev job `61f184ca`, round 2 — the sole-owner address path.
 *
 * The first cut of this fix was mutation-proven on the ADDRESS RESOLVER only. The
 * bug-hunter then found four defects on the code around it, all invisible to those
 * tests: a fail-open member lookup, a never-prefilled form, a write-back aimed at
 * whoever was logged in, and a write-back to a column the staff generator does not
 * read. Every one of those mutations stayed green.
 *
 * These tests cover the decision logic that surrounds the resolver. They are
 * deliberately written against PURE helpers so they can actually fail — the route
 * itself is a 700-line Next handler and a test that mocked its whole world would
 * assert the mock, not the behaviour.
 *
 * IMPORTANT CONTEXT, so nobody "simplifies" this away: a Single Member LLC has NO
 * member roster BY DESIGN (216 of the active accounts). "No member records" is
 * correct state, not a legacy gap and not a backfill candidate.
 */

import { describe, it, expect } from 'vitest'

import {
  splitStoredAddress,
  resolveOwnerOfRecord,
  canAuthorSoleOwnerAddress,
  type AccountContactLink,
} from '@/lib/members/sole-owner-address'

// ─── Prefill: the defect that made "we'll save it for you" a false promise ──

describe('splitStoredAddress', () => {
  it('round-trips a stored address back into the five fields it was joined from', () => {
    expect(splitStoredAddress('10225 Ulmerton Rd 3D, Largo, FL, 33771, United States')).toEqual({
      street: '10225 Ulmerton Rd 3D', city: 'Largo', state: 'FL', zip: '33771', country: 'United States',
    })
  })

  it('keeps a street that legitimately contains commas intact', () => {
    // Split from the right — the street is the only multi-comma part.
    expect(splitStoredAddress('10225 Ulmerton Rd, Suite 3D-205, Largo, FL, 33771, USA')).toEqual({
      street: '10225 Ulmerton Rd, Suite 3D-205', city: 'Largo', state: 'FL', zip: '33771', country: 'USA',
    })
  })

  it('THE DEFECT: an address on record must not open as a blank form', () => {
    // Blank here meant a client who regenerated without retyping stored an
    // agreement with NO address while their record held one.
    const prefilled = splitStoredAddress('PRACETA PEDRO IVO, 5, AMADORA, AMADORA, 2700-652, Portugal')
    expect(Object.values(prefilled).some(v => v !== '')).toBe(true)
    expect(prefilled.zip).toBe('2700-652')
    expect(prefilled.country).toBe('Portugal')
  })

  it('never guesses when there are too few parts — no city shifted into a state box', () => {
    expect(splitStoredAddress('Via Roma 1, Milano')).toEqual({
      street: 'Via Roma 1, Milano', city: '', state: '', zip: '', country: '',
    })
  })

  it('handles nothing on record without throwing', () => {
    const blank = { street: '', city: '', state: '', zip: '', country: '' }
    expect(splitStoredAddress(null)).toEqual(blank)
    expect(splitStoredAddress(undefined)).toEqual(blank)
    expect(splitStoredAddress('')).toEqual(blank)
    expect(splitStoredAddress('   ')).toEqual(blank)
  })
})

// ─── Who owns the address: the document follows the OWNER, not the login ───

const OWNER: AccountContactLink = { contact_id: 'c-owner', role: 'Owner' }
const ADMIN: AccountContactLink = { contact_id: 'c-admin', role: 'Administrator' }
const MEMBER: AccountContactLink = { contact_id: 'c-member', role: 'Member' }

describe('resolveOwnerOfRecord', () => {
  it('prefers an owner-ish role over anyone else, whatever the order or casing', () => {
    expect(resolveOwnerOfRecord([ADMIN, { contact_id: 'c-owner', role: 'sole member' }])).toBe('c-owner')
    expect(resolveOwnerOfRecord([ADMIN, OWNER])).toBe('c-owner')
  })

  it('falls back to a member-ish role, then to the first link', () => {
    expect(resolveOwnerOfRecord([ADMIN, MEMBER])).toBe('c-member')
    expect(resolveOwnerOfRecord([ADMIN])).toBe('c-admin')
  })

  it('returns null when nobody is linked', () => {
    expect(resolveOwnerOfRecord([])).toBeNull()
  })

  it('matches the SCREEN\'s preference order — the two must not disagree', () => {
    // If these ever diverge, the screen renders one person's address as editable
    // while the server writes it to another's record.
    const links = [MEMBER, ADMIN, OWNER]
    expect(resolveOwnerOfRecord(links)).toBe('c-owner')
  })
})

describe('canAuthorSoleOwnerAddress', () => {
  it('THE DEFECT: an administrator who is logged in may NOT author the owner\'s address', () => {
    expect(canAuthorSoleOwnerAddress({
      hasMemberRecords: false, ownerOfRecordContactId: 'c-owner', viewerContactId: 'c-admin',
    })).toBe(false)
  })

  it('the owner of record may', () => {
    expect(canAuthorSoleOwnerAddress({
      hasMemberRecords: false, ownerOfRecordContactId: 'c-owner', viewerContactId: 'c-owner',
    })).toBe(true)
  })

  it('nobody may when the company HAS member records — the record is authoritative', () => {
    // Every multi-member company. The address comes from the member row, full stop.
    expect(canAuthorSoleOwnerAddress({
      hasMemberRecords: true, ownerOfRecordContactId: 'c-owner', viewerContactId: 'c-owner',
    })).toBe(false)
  })

  it('nobody may when the owner cannot be established — fails closed', () => {
    expect(canAuthorSoleOwnerAddress({
      hasMemberRecords: false, ownerOfRecordContactId: null, viewerContactId: 'c-owner',
    })).toBe(false)
  })
})
